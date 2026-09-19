// Stdio smoke test: spawns dist/index.js as an MCP server, lists tools and calls the main ones
// against the live ENTRA API. Not shipped to npm (see "files" in package.json).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const PREVIEW = Number(process.env.SMOKE_PREVIEW ?? 700);

const watchdog = setTimeout(() => {
  console.error('smoke: timed out');
  process.exit(2);
}, 180_000);
watchdog.unref();

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
const client = new Client({ name: 'entra-smoke', version: '0.0.0' });
let failed = 0;

async function call(name, args) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  const ms = Date.now() - t0;
  if (res.isError) {
    failed++;
    console.log(`FAIL ${name} (${ms} ms): ${text.slice(0, 400)}`);
  } else {
    console.log(`PASS ${name} (${ms} ms): ${text.replace(/\s+/g, ' ').slice(0, PREVIEW)}`);
  }
  return res;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

  await call('search_jobs', { query: 'machine learning engineer', remote: true, rank_by: 'salary', limit: 3 });
  await call('search_jobs', { query: 'engineer', company: 'openai', posted_within_days: 14, limit: 3 });
  await call('search_jobs', { query: 'ai engineer', rank_by: 'fit', profile_keywords: ['python', 'llm', 'rag', 'aws'], limit: 3 });
  await call('match_jobs', {
    resume_text:
      'Senior Machine Learning Engineer with 7+ years of experience. Built RAG pipelines and LLM evals in Python (PyTorch, Hugging Face), deployed on AWS with Docker and Kubernetes. Strong SQL and PostgreSQL. Led a team of 4.',
    remote_only: true,
    limit: 3,
  });
  await call('match_profile', { skills: ['typescript', 'react', 'node.js'], role_hint: 'frontend engineer', limit: 2 });
  await call('salary_stats', { query: 'software engineer', country: 'US' });
  await call('companies_hiring', { query: 'machine learning', limit: 5 });
  await call('search_jobs', { query: 'engineer', country: 'XX', limit: 1 }); // expected: isError with country list
} catch (e) {
  failed++;
  console.error('smoke: error', e);
} finally {
  await client.close().catch(() => {});
}
console.log(failed === 1 ? '\nDone (1 expected error case)' : `\n${failed} unexpected failure(s)`);
process.exit(failed <= 1 ? 0 : 1);
