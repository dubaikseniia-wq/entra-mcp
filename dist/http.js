/**
 * ENTRA MCP — hosted Streamable HTTP entry: https://mcp.entracareers.com/mcp
 * Plain node:http, no web framework. The tools are the same as the stdio server (createServer in server.ts).
 *
 * Routes
 *   POST /mcp         MCP Streamable HTTP (JSON-RPC in; JSON or SSE out — the SDK transport decides)
 *   GET|DELETE /mcp   405 — see "Why stateless" below
 *   GET /healthz      { ok, version, uptime_s }
 *   GET /             JSON with docs links
 *   OPTIONS *         CORS preflight
 *
 * Why stateless (sessionIdGenerator: undefined, one fresh McpServer + transport per request):
 *   - Nothing to keep between requests: every tool is a self-contained call to the ENTRA API, and the only
 *     per-client state — the employer key — travels in the Authorization header of each request.
 *   - Any replica can answer any request (no sticky sessions, no session store), so the app can scale and
 *     restart freely; a client never sees "session not found" after a deploy.
 *   - GET /mcp would open a server→client SSE stream that this server never writes to, so it answers 405
 *     (allowed by the spec: "the server does not offer an SSE stream at this endpoint"); DELETE /mcp is 405
 *     because there is no session to terminate. The official SDK client treats both as normal.
 *
 * Per-request employer mode: `Authorization: Bearer entra_live_…` → createServer({ apiKey }) for that request
 *   only. The key is never read from the environment here and never logged (only method, path, status, timing
 *   and the JSON-RPC method / tool name are logged).
 *
 * Security notes
 *   - CORS is open (`*`) on purpose: this is a public read-mostly API; employer calls need a bearer key anyway.
 *   - DNS-rebinding protection (SDK enableDnsRebindingProtection) stays off: it guards *local* servers whose
 *     authority is "being reachable on localhost". This server is public behind TLS and grants nothing by origin.
 *     A light sanity check remains: Host must be present (and match MCP_ALLOWED_HOSTS when that is set),
 *     Origin, when present, must be a syntactically valid http(s) origin.
 *   - Body cap 1 MB, per-IP rate limit (RATE_LIMIT_PER_MINUTE, default 120) on /mcp, JSON errors everywhere.
 *
 * Env: PORT (8080) · HOST (0.0.0.0) · RATE_LIMIT_PER_MINUTE (120) · TRUST_PROXY (default 1: client IP from
 *   X-Forwarded-For — set 0 when not behind a load balancer) · MCP_ALLOWED_HOSTS (comma-separated, optional)
 *   · ENTRA_API_URL / ENTRA_SITE_URL as in server.ts.
 */
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { VERSION, createServer } from './server.js';
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY_BYTES = 1024 * 1024;
const RATE_LIMIT = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120) || 120);
const WINDOW_MS = 60_000;
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
const SHUTDOWN_GRACE_MS = 10_000;
const STARTED_AT = Date.now();
const DOCS = {
    developers: 'https://entracareers.com/developers',
    ai_agents: 'https://entracareers.com/ai-agents',
    npm: 'https://www.npmjs.com/package/entra-mcp',
    registry: 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.dubaikseniia-wq/entra-mcp',
    github: 'https://github.com/dubaikseniia-wq/entra-mcp',
    api_keys: 'https://entracareers.com/employer/profile?tab=api-keys',
};
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
    'access-control-max-age': '86400',
};
function sendJson(res, status, body, extra = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        ...CORS,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(text)),
        'cache-control': 'no-store',
        ...extra,
    });
    res.end(text);
}
/** JSON-RPC-shaped error body so MCP clients can surface it; `id` is null because we could not (or did not) parse a request id. */
const sendRpcError = (res, status, code, message, extra = {}) => sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);
function clientIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
        if (first)
            return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
}
// Fixed-window per-IP limiter for /mcp (health checks and the index are not counted). In-memory: per replica.
const buckets = new Map();
function retryAfterSeconds(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + WINDOW_MS };
        buckets.set(ip, b);
    }
    b.count++;
    return b.count > RATE_LIMIT ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : null;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets)
        if (b.resetAt <= now)
            buckets.delete(ip);
}, WINDOW_MS).unref();
/** Host / Origin sanity (MCP spec recommendation). Returns a rejection reason or null. */
function originHostProblem(req) {
    const host = req.headers.host;
    if (!host)
        return 'Missing Host header';
    if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host.replace(/:\d+$/, '').toLowerCase()))
        return 'Host not allowed';
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
        try {
            const u = new URL(origin);
            if (u.protocol !== 'http:' && u.protocol !== 'https:')
                return 'Invalid Origin';
        }
        catch {
            return 'Invalid Origin';
        }
    }
    return null;
}
/** `Authorization: Bearer entra_…` → the key; anything else → '' (candidate mode). Never logged. */
function bearerApiKey(req) {
    const m = /^Bearer\s+(entra_[A-Za-z0-9_-]+)\s*$/i.exec(req.headers.authorization ?? '');
    return m ? m[1] : '';
}
/** Reads the body with a hard cap; on overflow it answers 413 itself and resolves undefined. */
function readBody(req, res) {
    return new Promise((resolve) => {
        const tooLarge = () => {
            sendRpcError(res, 413, -32600, `Request body too large (max ${MAX_BODY_BYTES} bytes)`, { connection: 'close' });
            res.once('finish', () => req.destroy());
            resolve(undefined);
        };
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
            return tooLarge();
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled)
                return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                settled = true;
                req.removeAllListeners('data');
                return tooLarge();
            }
            chunks.push(chunk);
        });
        req.once('end', () => {
            if (!settled) {
                settled = true;
                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        });
        req.once('error', () => {
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });
    });
}
/** For the access log only: "initialize", "tools/list", "tools/call:search_jobs", … — never arguments. */
function rpcSummary(body) {
    const one = (m) => {
        if (!m || typeof m !== 'object')
            return '?';
        const { method, params } = m;
        if (typeof method !== 'string')
            return 'response';
        return method === 'tools/call' && typeof params?.name === 'string' ? `tools/call:${params.name}` : method;
    };
    return Array.isArray(body) ? `batch[${body.map(one).join(',')}]` : one(body);
}
// ---------- /mcp ----------
/** `note` receives a short access-log tag (JSON-RPC method + mode) before the response starts. */
async function handleMcp(req, res, note) {
    if (req.method !== 'POST') {
        // Stateless: no server→client stream to open (GET) and no session to terminate (DELETE).
        return sendRpcError(res, 405, -32000, 'Method not allowed: this endpoint is stateless — send JSON-RPC via POST', { allow: 'POST, OPTIONS' });
    }
    const raw = await readBody(req, res);
    if (raw === undefined)
        return;
    let body;
    try {
        body = raw.trim() ? JSON.parse(raw) : undefined;
    }
    catch {
        return sendRpcError(res, 400, -32700, 'Parse error: body is not valid JSON');
    }
    if (body === undefined)
        return sendRpcError(res, 400, -32600, 'Invalid Request: empty body');
    const apiKey = bearerApiKey(req);
    note(`${rpcSummary(body)} ${apiKey ? 'employer' : 'candidate'}`);
    const server = createServer({ apiKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    res.once('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
    });
    for (const [k, v] of Object.entries(CORS))
        res.setHeader(k, v); // merged into the transport's writeHead
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    }
    catch (e) {
        console.error(`entra-mcp http: /mcp failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent)
            sendRpcError(res, 500, -32603, 'Internal error');
        else
            res.end();
    }
}
// ---------- server ----------
let shuttingDown = false;
let inFlight = 0;
const httpServer = http.createServer(async (req, res) => {
    const t0 = Date.now();
    inFlight++;
    let note = '';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    res.once('finish', () => {
        inFlight--;
        if (path !== '/healthz')
            console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms${note ? ` ${note}` : ''}`);
    });
    res.once('close', () => {
        if (!res.writableFinished)
            inFlight--; // aborted before finish
    });
    try {
        if (shuttingDown)
            return sendRpcError(res, 503, -32000, 'Server is shutting down', { connection: 'close', 'retry-after': '2' });
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS);
            return res.end();
        }
        const problem = originHostProblem(req);
        if (problem)
            return sendRpcError(res, 403, -32000, problem);
        if (path === '/mcp') {
            const retry = retryAfterSeconds(clientIp(req));
            if (retry !== null) {
                return sendRpcError(res, 429, -32000, `Rate limit: ${RATE_LIMIT} requests/minute per client — retry in ${retry}s`, {
                    'retry-after': String(retry),
                });
            }
            return handleMcp(req, res, (tag) => (note = tag));
        }
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return sendRpcError(res, 405, -32000, 'Method not allowed', { allow: 'GET, HEAD, OPTIONS' });
        if (path === '/healthz')
            return sendJson(res, 200, { ok: true, version: VERSION, uptime_s: Math.round((Date.now() - STARTED_AT) / 1000) });
        if (path === '/') {
            return sendJson(res, 200, {
                name: 'entra-mcp',
                version: VERSION,
                description: 'ENTRA — the agent-ready job platform. MCP over Streamable HTTP: verified AI & tech jobs, fit matching, salary stats; employer tools with an API key.',
                endpoint: '/mcp',
                transport: 'streamable-http',
                auth: 'Optional. Employer mode: "Authorization: Bearer entra_live_…" on every request (key from docs.api_keys). Without it: 8 read-only candidate tools.',
                health: '/healthz',
                docs: DOCS,
            });
        }
        return sendRpcError(res, 404, -32000, `Not found: ${path}`);
    }
    catch (e) {
        console.error(`entra-mcp http: unhandled: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        if (!res.headersSent)
            sendRpcError(res, 500, -32603, 'Internal error');
        else
            res.end();
    }
});
// Behind a load balancer keep our idle timeout above the LB's (DigitalOcean/ALB ≈ 60 s) to avoid racy 502s.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.error(`entra-mcp http: ${signal} — draining ${inFlight} in-flight request(s)`);
    httpServer.close(() => {
        console.error('entra-mcp http: closed');
        process.exit(0);
    });
    httpServer.closeIdleConnections();
    setTimeout(() => {
        console.error('entra-mcp http: grace period over — closing remaining connections');
        httpServer.closeAllConnections();
        process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
httpServer.listen(PORT, HOST, () => {
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : PORT;
    console.log(`entra-mcp ${VERSION} http: listening on http://${HOST}:${port}/mcp (stateless streamable-http, ${RATE_LIMIT} req/min per IP, body ≤ ${MAX_BODY_BYTES} B)`);
});
