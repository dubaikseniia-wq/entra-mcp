// HTTP smoke test: starts dist/http.js on a random port and drives it with the MCP SDK's
// StreamableHTTPClientTransport against the live ENTRA API (candidate tools). Employer mode is checked with a
// fake key: the tool list must grow to 16 and employer_whoami must come back as a structured AUTH_ERROR from
// the live API — proof that the per-request bearer reached the API layer. Also: /healthz, /, CORS preflight,
// 405/400/413/404 JSON errors, rate limit, "key never logged", graceful SIGTERM, no lingering process.
// Not shipped to npm (see "files" in package.json).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'http.js');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const PREVIEW = Number(process.env.SMOKE_PREVIEW ?? 220);
const FAKE_KEY = 'entra_live_test';

const watchdog = setTimeout(() => {
  console.error('smoke-http: timed out');
  process.exit(2);
}, 180_000);
watchdog.unref();

let failed = 0;
const check = (cond, label) => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
};
const brief = (s) => String(s).replace(/\s+/g, ' ').slice(0, PREVIEW);

const EMPLOYER_TOOLS = ['employer_whoami', 'post_job', 'my_jobs', 'close_job', 'update_job', 'job_applications', 'search_candidates', 'match_candidates'];
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-http-raw', version: '0' } },
};
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', ...extraEnv };
    delete env.ENTRA_API_KEY; // the hosted server must never take a key from the environment
    const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const handle = { child, port: 0, stdout: () => out, stderr: () => err };
    child.stdout.on('data', (d) => {
      out += d;
      if (!handle.port) {
        const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(out);
        if (m) {
          handle.port = Number(m[1]);
          resolve(handle);
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (!handle.port) reject(new Error(`server exited early (code ${code}): ${err}`));
    });
  });
}

/** SIGTERM → must exit 0 promptly and be gone from the process table. */
function stopServer(h, label) {
  return new Promise((resolve) => {
    const killer = setTimeout(() => {
      h.child.kill('SIGKILL');
    }, 10_000);
    h.child.once('exit', (code, signal) => {
      clearTimeout(killer);
      let gone = false;
      try {
        process.kill(h.child.pid, 0);
      } catch {
        gone = true;
      }
      check(code === 0 && signal === null, `${label}: SIGTERM → clean exit (code ${code}, signal ${signal})`);
      check(gone, `${label}: no lingering process`);
      resolve();
    });
    h.child.kill('SIGTERM');
  });
}

async function mcpClient(base, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), headers ? { requestInit: { headers } } : undefined);
  const client = new Client({ name: 'entra-smoke-http', version: '0.0.0' });
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  console.log(`  ${name} ${JSON.stringify(args)} → ${Date.now() - t0} ms${r.isError ? ' [isError]' : ''}: ${brief(text)}`);
  return { ...r, text, data };
}

let main = null;
let limited = null;
try {
  main = await startServer();
  const base = `http://127.0.0.1:${main.port}`;
  console.log(`server up on ${base} (pid ${main.child.pid})`);

  // ----- plain HTTP surface -----
  const health = await fetch(`${base}/healthz`);
  const healthBody = await health.json();
  check(health.status === 200 && healthBody.ok === true && healthBody.version === pkg.version, `GET /healthz → 200 {ok:true, version:${healthBody.version}}`);

  const index = await fetch(`${base}/`);
  const indexBody = await index.json();
  check(index.status === 200 && indexBody.endpoint === '/mcp' && indexBody.docs?.developers === 'https://entracareers.com/developers' && /npmjs\.com\/package\/entra-mcp/.test(indexBody.docs?.npm ?? '') && /registry\.modelcontextprotocol\.io/.test(indexBody.docs?.registry ?? ''), 'GET / → docs links (developers, npm, registry)');

  const pre = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, mcp-session-id' },
  });
  const allowHeaders = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  check(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', `CORS preflight → ${pre.status}, allow-origin *`);
  check(['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version'].every((h) => allowHeaders.includes(h)) && /post/i.test(pre.headers.get('access-control-allow-methods') ?? '') && /delete/i.test(pre.headers.get('access-control-allow-methods') ?? ''), 'CORS preflight allows Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version; methods GET/POST/DELETE');
  check(/mcp-session-id/i.test(pre.headers.get('access-control-expose-headers') ?? ''), 'CORS exposes Mcp-Session-Id');

  const rawInit = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, origin: 'https://claude.ai' }, body: JSON.stringify(INIT) });
  const rawInitText = await rawInit.text();
  const ct = rawInit.headers.get('content-type') ?? '';
  check(rawInit.status === 200 && /application\/json|text\/event-stream/.test(ct) && /"protocolVersion"/.test(rawInitText) && /"serverInfo"/.test(rawInitText), `raw POST initialize → 200 (${ct.split(';')[0]})`);
  check(rawInit.headers.get('access-control-allow-origin') === '*', 'MCP POST response carries CORS allow-origin *');
  check(rawInit.headers.get('mcp-session-id') === null, 'stateless: no Mcp-Session-Id issued');

  const get = await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } });
  check(get.status === 405 && /post/i.test(get.headers.get('allow') ?? '') && (await get.json()).error?.code === -32000, 'GET /mcp → 405 JSON-RPC error with Allow: POST');
  const del = await fetch(`${base}/mcp`, { method: 'DELETE' });
  check(del.status === 405, 'DELETE /mcp → 405');
  const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{"jsonrpc":' });
  check(bad.status === 400 && (await bad.json()).error?.code === -32700, 'POST invalid JSON → 400 parse error (-32700)');
  const empty = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '' });
  check(empty.status === 400, 'POST empty body → 400');
  const noAccept = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT) });
  check(noAccept.status === 406, 'POST without Accept text/event-stream → 406 (spec)');
  const big = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ ...INIT, params: { ...INIT.params, pad: 'x'.repeat(1024 * 1024 + 100) } }) }).catch((e) => ({ status: `fetch error: ${e.cause?.code ?? e.message}` }));
  check(big.status === 413, `POST > 1 MB → ${big.status}`);
  const nf = await fetch(`${base}/nope`);
  check(nf.status === 404 && (await nf.json()).error, 'GET /nope → 404 JSON');
  const badOrigin = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, origin: 'not a url' }, body: JSON.stringify(INIT) });
  check(badOrigin.status === 403, 'malformed Origin → 403');

  // ----- candidate mode via the SDK client (no auth) -----
  const cand = await mcpClient(base);
  const sv = cand.getServerVersion();
  check(sv?.name === 'entra' && sv?.version === pkg.version, `initialize: server ${sv?.name} ${sv?.version}`);
  const candTools = (await cand.listTools()).tools;
  const candNames = candTools.map((t) => t.name);
  check(candTools.length === 8 && candNames.includes('search_jobs') && candNames.includes('match_jobs') && !EMPLOYER_TOOLS.some((n) => candNames.includes(n)), `no auth → ${candTools.length} tools (candidate only)`);
  check(candTools.every((t) => t.title && t.annotations?.readOnlyHint === true), 'candidate tools carry title + readOnlyHint');
  check(/not loaded/.test(cand.getInstructions() ?? '') && /Authorization: Bearer/.test(cand.getInstructions() ?? ''), 'instructions explain how to add a key on the hosted endpoint');
  const s = await call(cand, 'search_jobs', { query: 'machine learning', limit: 3 });
  check(!s.isError && Array.isArray(s.data?.jobs) && s.data.jobs.length > 0 && typeof s.data.total_found === 'number', `search_jobs (live API) → ${s.data?.jobs?.length} jobs of ${s.data?.total_found}`);
  check(s.data?.jobs?.every((j) => j.verified === true && /utm_source=agent/.test(j.url ?? '')), 'jobs are verified with agent utm links');
  const c2 = await mcpClient(base); // second independent client: stateless server serves both
  check((await c2.listTools()).tools.length === 8, 'second client (no session sharing) → 8 tools');
  await c2.close();
  await cand.close();

  // ----- employer mode via per-request Authorization header -----
  const emp = await mcpClient(base, { Authorization: `Bearer ${FAKE_KEY}` });
  const empTools = (await emp.listTools()).tools;
  const empNames = empTools.map((t) => t.name);
  check(empTools.length === 16 && EMPLOYER_TOOLS.every((n) => empNames.includes(n)), `Authorization: Bearer ${FAKE_KEY} → ${empTools.length} tools (8 candidate + 8 employer)`);
  check(/Employer mode is ON/.test(emp.getInstructions() ?? ''), 'instructions switch to employer mode');
  const who = await call(emp, 'employer_whoami', {});
  check(who.isError === true && [401, 403].includes(who.data?.status) && /employer\/api-keys\/me/.test(who.data?.error ?? '') && /api-keys/.test(who.data?.hint ?? ''), `employer_whoami with a fake key → structured ${who.data?.code} ${who.data?.status} from the live API (bearer reached the API layer)`);
  const still = await call(emp, 'search_jobs', { query: 'engineer', limit: 1 });
  check(!still.isError && still.data?.jobs?.length === 1, 'candidate tools still work with a key present');
  await emp.close();

  // a key that does not look like an ENTRA key is ignored → candidate mode, not a broken employer mode
  const foreign = await mcpClient(base, { Authorization: 'Bearer some-oauth-token' });
  check((await foreign.listTools()).tools.length === 8, 'non-ENTRA bearer token → ignored (8 tools)');
  await foreign.close();

  // ----- secrets & logs -----
  check(!main.stdout().includes(FAKE_KEY) && !main.stderr().includes(FAKE_KEY), 'API key never appears in server logs');
  check(/POST \/mcp 200 \d+ms tools\/call:search_jobs candidate/.test(main.stdout()) && /tools\/call:employer_whoami employer/.test(main.stdout()), 'access log shows method/tool/mode only');

  // ----- rate limit (separate instance with a tiny limit) -----
  limited = await startServer({ RATE_LIMIT_PER_MINUTE: '3' });
  const lb = `http://127.0.0.1:${limited.port}`;
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${lb}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT) });
    await r.text();
    statuses.push(r.status);
    if (i === 3) check(r.status === 429 && Number(r.headers.get('retry-after')) >= 1 && (await fetch(`${lb}/healthz`)).status === 200, `rate limit: statuses ${statuses.join(',')} — 4th is 429 with Retry-After; /healthz unaffected`);
  }
} catch (e) {
  failed++;
  console.error('smoke-http: error', e);
} finally {
  if (main) await stopServer(main, 'main server');
  if (limited) await stopServer(limited, 'rate-limited server');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll HTTP smoke checks passed');
process.exit(failed ? 1 : 0);
