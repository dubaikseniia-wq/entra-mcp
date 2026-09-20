// Employer-mode smoke test: starts a tiny in-process mock of the ENTRA employer API (node:http,
// shaped after API-CONTRACT.md) and drives dist/index.js over stdio with the MCP SDK client.
// No network, no real key. Not shipped to npm (see "files" in package.json).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const PREVIEW = Number(process.env.SMOKE_PREVIEW ?? 260);

const watchdog = setTimeout(() => {
  console.error('smoke-employer: timed out');
  process.exit(2);
}, 120_000);
watchdog.unref();

// ---------- mock backend (contract shapes) ----------
const COMPANY = { id: 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Acme Logistics', slug: 'acme-logistics' };
const KEYS = {
  entra_live_test: { id: 'k-1', name: 'Claude MCP', keyPrefix: 'entra_live_test', scopes: ['jobs:read', 'jobs:write', 'applications:read', 'candidates:read'] },
  entra_live_readonly: { id: 'k-2', name: 'Read only', keyPrefix: 'entra_live_read', scopes: ['jobs:read'] },
};
const COUNTRIES = [
  { id: 'c-ae', nameEn: 'United Arab Emirates', code: 'AE', slug: 'united-arab-emirates' },
  { id: 'c-us', nameEn: 'United States', code: 'US', slug: 'united-states' },
];
const CITIES = [
  { id: 'city-dxb', nameEn: 'Dubai', slug: 'dubai', countryId: 'c-ae' },
  { id: 'city-auh', nameEn: 'Abu Dhabi', slug: 'abu-dhabi', countryId: 'c-ae' },
  { id: 'city-nyc', nameEn: 'New York', slug: 'new-york', countryId: 'c-us' },
  { id: 'city-sf', nameEn: 'San Francisco', slug: 'san-francisco', countryId: 'c-us' },
];
const SPECS = [
  { id: 'spec-sales-legacy', nameEn: 'Sales Manager (legacy)', slug: 'sales-manager-legacy', isActive: false },
  { id: 'spec-sales', nameEn: 'Sales Manager', slug: 'sales-manager', isActive: true },
  { id: 'spec-ml', nameEn: 'Machine Learning Engineer', slug: 'machine-learning-engineer', isActive: true },
];
const SKILLS = [
  { id: 'sk-python', nameEn: 'Python', nameAr: '', slug: 'python', type: 'hard' },
  { id: 'sk-pytorch', nameEn: 'PyTorch', nameAr: '', slug: 'pytorch', type: 'hard' },
  { id: 'sk-llm', nameEn: 'LLM', nameAr: '', slug: 'llm', type: 'hard' },
  { id: 'sk-sales', nameEn: 'Enterprise Sales', nameAr: '', slug: 'enterprise-sales', type: 'hard' },
  { id: 'sk-crm', nameEn: 'CRM', nameAr: '', slug: 'crm', type: 'hard' },
];
const noContact = { phone: null, whatsapp: null, linkedinUrl: null, portfolioUrl: null };
const RESUMES = [
  {
    id: 'r-1', title: 'Senior Sales Manager', bio: 'Enterprise sales in GCC logistics, CRM pipelines', experienceLevel: '3_6_years',
    countryId: 'c-ae', cityId: 'city-dxb', workLocation: 'hybrid', isReadyToRelocate: 'not_ready',
    desiredSalaryMin: 15000, desiredSalaryMax: 20000, salaryCurrency: 'AED', salaryPeriod: 'monthly',
    publishedAt: '2026-09-01T00:00:00.000Z', status: 'published', completionPercentage: 90, skills: [SKILLS[3], SKILLS[4]], specialization: SPECS[1],
    user: { id: 'u-1', profile: { firstName: 'Dana', lastName: 'K.', avatarUrl: null } }, hasFullAccess: false, ...noContact,
    experience: [{ title: 'Sales Manager', company: 'Aramex', isCurrent: true }], resumeLanguages: [{ language: { name: 'English', code: 'en' }, level: 'native' }], educations: [],
  },
  {
    id: 'r-2', title: 'Machine Learning Engineer', bio: 'Python, PyTorch, LLM fine-tuning', experienceLevel: '6_plus_years',
    countryId: 'c-us', cityId: 'city-sf', workLocation: 'remote', isReadyToRelocate: 'considering',
    publishedAt: '2026-08-20T00:00:00.000Z', status: 'published', completionPercentage: 100, skills: [SKILLS[0], SKILLS[1], SKILLS[2]], specialization: SPECS[2],
    user: { id: 'u-2', email: 'ml@example.com', profile: { firstName: 'Sam', lastName: 'Lee', avatarUrl: null } }, hasFullAccess: true,
    phone: '+1 555 0100', whatsapp: null, linkedinUrl: 'https://linkedin.com/in/samlee', portfolioUrl: null,
    experience: [{ title: 'ML Engineer', company: 'OpenAI', isCurrent: true }], resumeLanguages: [], educations: [{ degree: 'MSc', field: 'CS', institution: 'MIT' }],
  },
  {
    id: 'r-3', title: 'Junior Sales Executive', bio: 'B2B sales, CRM', experienceLevel: '1_3_years',
    countryId: 'c-us', cityId: 'city-nyc', workLocation: 'office', isReadyToRelocate: 'ready',
    publishedAt: '2026-07-01T00:00:00.000Z', status: 'published', completionPercentage: 60, skills: [SKILLS[4]], specialization: SPECS[1],
    user: { id: 'u-3', profile: { firstName: 'Ana', lastName: 'M.', avatarUrl: null } }, hasFullAccess: false, ...noContact,
    experience: [], resumeLanguages: [], educations: [],
  },
];
const jobs = new Map();
const requests = [];
let myJobsHits = 0;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, message) => json(res, status, { statusCode: status, code, error: code, message });
const has = (list, q, field = 'nameEn') => (!q ? list : list.filter((x) => String(x[field]).toLowerCase().includes(q.toLowerCase())));
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(s ? JSON.parse(s) : {})); });
const fullJob = (j) => ({
  ...j,
  company: COMPANY,
  country: COUNTRIES.find((c) => c.id === j.countryId),
  city: CITIES.find((c) => c.id === j.cityId),
  specialization: SPECS.find((s) => s.id === j.specializationId),
  skills: (j.skills ?? []).map((s) => SKILLS.find((k) => k.id === s.skillId)).filter(Boolean),
  _count: { applications: 2 },
});
function auth(req, res) {
  const m = /^Bearer (entra_live_\w+)$/.exec(req.headers.authorization ?? '');
  if (!m) return err(res, 401, 'AUTH_ERROR', 'Invalid API key'), null;
  if (m[1] === 'entra_live_revoked') return err(res, 401, 'AUTH_ERROR', 'API key has been revoked'), null;
  const key = KEYS[m[1]];
  if (!key) return err(res, 401, 'AUTH_ERROR', 'Invalid API key'), null;
  return key;
}
function scoped(req, res, scope) {
  const k = auth(req, res);
  if (!k) return null;
  if (!k.scopes.includes(scope)) return err(res, 403, 'FORBIDDEN', `API key is missing required scope: ${scope}`), null;
  return k;
}
const PUBLIC = (p, method) => p.startsWith('/references/') || (method === 'GET' && (p === '/jobs' || /^\/jobs\/[^/]+$/.test(p)));

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/^\/api/, '');
  const q = Object.fromEntries(url.searchParams);
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : null;
  requests.push({ method: req.method, path: p, auth: !!req.headers.authorization, query: url.search, body });
  try {
    if (p === '/employer/api-keys/me') {
      const key = auth(req, res);
      if (!key) return;
      return json(res, 200, { data: { authMethod: 'api_key', user: { id: 'u-hr', email: 'hr@acme.com', firstName: 'Dana', lastName: 'Khalil', role: 'employer' }, apiKey: key, company: COMPANY } });
    }
    // Default deny (api-key-auth.ts): public routes are not opted in, a bearer there is a 403.
    if (PUBLIC(p, req.method) && req.headers.authorization) return err(res, 403, 'FORBIDDEN', 'This endpoint is not available with API key authentication');
    if (p === '/references/countries') return json(res, 200, { data: has(COUNTRIES, q.search), total: COUNTRIES.length, page: 1, limit: 100 });
    if (p === '/references/cities') {
      const list = has(CITIES.filter((c) => !q.countryId || c.countryId === q.countryId), q.search);
      return json(res, 200, { data: list, total: list.length, page: 1, limit: 25 });
    }
    if (p === '/references/specializations') { const list = has(SPECS, q.search); return json(res, 200, { data: list, total: list.length, page: 1, limit: 25 }); }
    if (p === '/references/skills') { const list = has(SKILLS, q.search); return json(res, 200, { data: list, total: list.length, page: 1, limit: 25 }); }
    if (p === '/jobs' && req.method === 'POST') {
      if (!scoped(req, res, 'jobs:write')) return;
      if (body.companyId !== COMPANY.id) return err(res, 403, 'FORBIDDEN', 'API key is bound to a different company');
      if (/LIMIT/.test(body.title)) return err(res, 403, 'FORBIDDEN', 'Your vacancy limit has been reached. Upgrade your plan to post more jobs.');
      const required = ['title', 'description', 'employmentType', 'workLocation', 'experienceLevel', 'countryId', 'cityId', 'specializationId', 'expiresAt'];
      const missing = required.filter((f) => body[f] === undefined);
      if (missing.length) return json(res, 400, { statusCode: 400, code: 'VALIDATION_ERROR', error: 'Bad Request', message: 'Validation failed', validation: missing.map((f) => ({ field: f, message: 'required' })) });
      if (!['office', 'remote', 'hybrid'].includes(body.workLocation)) return err(res, 400, 'VALIDATION_ERROR', `bad workLocation ${body.workLocation}`);
      const job = { id: `job-${jobs.size + 1}`, isActive: true, publishedAt: new Date().toISOString(), ...body };
      jobs.set(job.id, job);
      return json(res, 201, { data: fullJob(job) });
    }
    if (/^\/jobs\/[^/]+$/.test(p) && req.method === 'GET') {
      const j = jobs.get(p.split('/')[2]);
      if (!j || !j.isActive) return err(res, 404, 'NOT_FOUND', 'Job not found'); // closed jobs are hidden publicly
      return json(res, 200, { data: fullJob(j) });
    }
    if (/^\/jobs\/[^/]+$/.test(p) && req.method === 'PATCH') {
      if (!scoped(req, res, 'jobs:write')) return;
      const j = jobs.get(p.split('/')[2]);
      if (!j) return err(res, 404, 'NOT_FOUND', 'Job not found');
      Object.assign(j, body);
      return json(res, 200, { data: fullJob(j) });
    }
    if (p === '/my-jobs') {
      if (!scoped(req, res, 'jobs:read')) return;
      if (++myJobsHits === 1) {
        return json(res, 429, { statusCode: 429, code: 'API_KEY_RATE_LIMIT_EXCEEDED', error: 'Too Many Requests', message: 'API key rate limit exceeded. You can make 120 requests per minute.' }, { 'retry-after': '0' });
      }
      let list = [...jobs.values()];
      if (q.isActive !== undefined) list = list.filter((j) => String(j.isActive) === q.isActive);
      if (q.search) list = has(list, q.search, 'title');
      return json(res, 200, { data: list.map(fullJob), total: list.length, page: 1, limit: Number(q.limit ?? 20), totalPages: 1 });
    }
    if (/^\/jobs\/[^/]+\/applications$/.test(p) || p === '/employer/applications') {
      if (!scoped(req, res, 'applications:read')) return;
      const jobId = p === '/employer/applications' ? 'job-1' : p.split('/')[2];
      const jobInfo = { id: jobId, title: jobs.get(jobId)?.title ?? 'Job', description: 'x', employmentType: 'full_time', workLocation: 'hybrid', experienceLevel: '3_6_years' };
      const apps = [
        { id: 'app-1', jobId, userId: 'u-2', resumeId: 'r-2', status: 'pending', coverLetter: 'I built RAG pipelines at scale.', appliedAt: '2026-09-10T10:00:00.000Z', isUnread: true, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T10:00:00.000Z',
          user: { id: 'u-2', firstName: 'Sam', lastName: 'Lee', email: 'ml@example.com', phone: '+1 555 0100' }, job: jobInfo, resume: { id: 'r-2', title: 'Machine Learning Engineer', linkedinUrl: 'https://linkedin.com/in/samlee', bio: 'Python, PyTorch' } },
        { id: 'app-2', jobId, userId: 'u-1', resumeId: 'r-1', status: 'interview', appliedAt: '2026-09-11T10:00:00.000Z', isUnread: false, createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
          user: { id: 'u-1', firstName: 'Dana', lastName: 'K.', email: 'dana@example.com' }, job: jobInfo, resume: { id: 'r-1', title: 'Senior Sales Manager' } },
      ];
      return json(res, 200, { success: true, data: apps, total: apps.length, page: 1, limit: Number(q.limit ?? 20) });
    }
    if (p === '/resumes') {
      if (!scoped(req, res, 'candidates:read')) return;
      if (q.search === 'NEEDS_SUB') return err(res, 403, 'FORBIDDEN', 'Resume database access requires an active subscription.');
      const skillIds = url.searchParams.getAll('skills');
      let list = RESUMES;
      if (q.search) list = list.filter((r) => `${r.title} ${r.bio}`.toLowerCase().includes(q.search.toLowerCase()));
      if (skillIds.length) list = list.filter((r) => r.skills.some((s) => skillIds.includes(s.id)));
      if (q.countryId) list = list.filter((r) => r.countryId === q.countryId);
      if (q.experienceLevel) list = list.filter((r) => r.experienceLevel === q.experienceLevel);
      if (q.workLocation) list = list.filter((r) => r.workLocation === q.workLocation);
      return json(res, 200, { data: list.slice(0, Number(q.limit ?? 20)), total: list.length, page: 1, limit: Number(q.limit ?? 20) });
    }
    err(res, 404, 'NOT_FOUND', `no mock for ${req.method} ${p}`);
  } catch (e) {
    err(res, 500, 'MOCK_ERROR', String(e));
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const API_URL = `http://127.0.0.1:${mock.address().port}/api`;

// ---------- harness ----------
let failed = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
};
async function spawn(apiKey, args = []) {
  const env = { ...process.env, ENTRA_API_URL: API_URL };
  delete env.ENTRA_API_KEY;
  if (apiKey) env.ENTRA_API_KEY = apiKey;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, ...args], env, stderr: 'pipe' });
  let stderr = '';
  const client = new Client({ name: 'entra-smoke-employer', version: '0.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => (stderr += d));
  return { client, stderr: () => stderr };
}
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  console.log(`${res.isError ? 'ERR ' : 'PASS'} ${name}: ${text.replace(/\s+/g, ' ').slice(0, PREVIEW)}`);
  return { isError: !!res.isError, data, text };
}
const EMPLOYER_TOOLS = ['employer_whoami', 'post_job', 'my_jobs', 'close_job', 'update_job', 'job_applications', 'search_candidates', 'match_candidates'];
const minimalJob = { title: 'Sales Manager', description: 'Lead our regional sales team and grow revenue.', employment_type: 'full_time', work_location: 'onsite', country: 'AE', city: 'Dubai' };

try {
  console.log(`mock ENTRA API at ${API_URL}\n`);

  console.log('A) no key, --employer flag → candidate mode only');
  {
    const s = await spawn('', ['--employer']);
    const { tools } = await s.client.listTools();
    check(tools.length === 8 && !tools.some((t) => EMPLOYER_TOOLS.includes(t.name)), `${tools.length} tools, employer tools absent`);
    await new Promise((r) => setTimeout(r, 50));
    check(/--employer given but ENTRA_API_KEY is not set/.test(s.stderr()), 'stderr hint about the missing key');
    await s.client.close();
  }

  console.log('B) revoked key → registered, no startup call, friendly 401');
  {
    const before = requests.length;
    const s = await spawn('entra_live_revoked');
    const { tools } = await s.client.listTools();
    check(tools.length === 16, '16 tools registered');
    check(requests.length === before, 'no network call at startup / listTools');
    const r = await call(s.client, 'employer_whoami', {});
    check(r.isError && r.data?.status === 401 && /employer\/profile\?tab=api-keys/.test(r.data?.hint ?? ''), '401 → structured error with api-keys URL hint');
    await s.client.close();
  }

  console.log('C) key without jobs:write → MISSING_SCOPE before any POST');
  {
    const s = await spawn('entra_live_readonly');
    const posts = requests.filter((x) => x.method === 'POST').length;
    const r = await call(s.client, 'post_job', minimalJob);
    check(r.isError && r.data?.code === 'MISSING_SCOPE' && requests.filter((x) => x.method === 'POST').length === posts, 'scope checked locally, nothing posted');
    await s.client.close();
  }

  console.log('D) full key → every employer tool');
  {
    const start = requests.length;
    const s = await spawn('entra_live_test', ['--employer']);
    const c = s.client;
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    check(tools.length === 16 && EMPLOYER_TOOLS.every((n) => names.includes(n)), `16 tools: ${names.join(', ')}`);
    const closeTool = tools.find((t) => t.name === 'close_job');
    const postTool = tools.find((t) => t.name === 'post_job');
    check(closeTool?.annotations?.destructiveHint === true && closeTool?.annotations?.readOnlyHint === false, 'close_job annotations: destructive, not read-only');
    check(postTool?.annotations?.readOnlyHint === false && postTool?.annotations?.openWorldHint === true, 'post_job annotations: write, open world');

    const who = await call(c, 'employer_whoami', {});
    check(!who.isError && who.data?.company?.name === 'Acme Logistics' && who.data?.api_key?.scopes?.length === 4, 'employer_whoami → company + 4 scopes');

    const posted = await call(c, 'post_job', {
      title: 'Senior Sales Manager',
      description: 'Own the GCC enterprise pipeline for our logistics platform. 5+ years of enterprise sales experience required.',
      employment_type: 'full_time',
      work_location: 'hybrid',
      country: 'UAE',
      city: 'dubai',
      salary_min: 15000,
      salary_max: 22000,
      salary_currency: 'aed',
      skills: ['Enterprise Sales', 'CRM', 'Quantum Sales'],
      benefits: ['Medical insurance'],
      expires_in_days: 45,
    });
    check(!posted.isError && posted.data?.posted === true, 'post_job → posted');
    check(posted.data?.job?.url === 'https://entracareers.com/ae/vacancies/job-1' && posted.data?.job?.manage_url === 'https://entracareers.com/employer/jobs/job-1', `urls: ${posted.data?.job?.url} · ${posted.data?.job?.manage_url}`);
    check(posted.data?.resolved?.city === 'Dubai' && posted.data?.resolved?.specialization === 'Sales Manager', 'resolved city=Dubai, specialization=Sales Manager (active one, not legacy)');
    check(posted.data?.resolved?.experience_level === '3_6_years', '"5+ years" → experience_level 3_6_years');
    check(posted.data?.resolved?.skills?.length === 2 && /Quantum Sales/.test((posted.data?.notes ?? []).join(' ')), 'skills: 2 resolved, "Quantum Sales" reported as unresolved');
    const postReq = requests.find((x) => x.method === 'POST' && x.path === '/jobs');
    const b = postReq?.body ?? {};
    const daysOut = (Date.parse(b.expiresAt) - Date.now()) / 86_400_000;
    check(b.companyId === COMPANY.id && b.workLocation === 'hybrid' && b.countryId === 'c-ae' && b.cityId === 'city-dxb' && b.specializationId === 'spec-sales', 'POST body: companyId from whoami, office/remote/hybrid enum, resolved ids');
    check(b.salaryCurrency === 'AED' && b.salaryPeriod === 'monthly' && daysOut > 44 && daysOut < 46, `POST body: AED monthly, expiresAt in ${daysOut.toFixed(1)} days`);
    check(b.skills?.length === 2 && b.skills[0].skillId === 'sk-sales', 'POST body: skills as [{skillId,isRequired}]');

    const limited = await call(c, 'post_job', { ...minimalJob, title: 'LIMIT reached role', specialization: 'Sales Manager' });
    check(!limited.isError && limited.data?.needs_subscription === true && limited.data?.pricing_url === 'https://entracareers.com/employer/pricing' && /Founding plan/.test(limited.data?.note), '403 vacancy limit → needs_subscription (not an error)');

    const mine = await call(c, 'my_jobs', {});
    check(!mine.isError && mine.data?.jobs?.length === 1 && mine.data.jobs[0].id === 'job-1' && mine.data.jobs[0].applications === 2, 'my_jobs → 1 active job with applications count');
    check(requests.filter((x) => x.path === '/my-jobs').length === 2, 'my_jobs: first 429 retried once (2 hits)');

    const upd = await call(c, 'update_job', { job_id: 'job-1', salary_max: 25000, expires_in_days: 60 });
    check(!upd.isError && upd.data?.updated === true && upd.data.fields.includes('salaryMax') && upd.data.fields.includes('expiresAt'), 'update_job → salaryMax + expiresAt patched');
    const noop = await call(c, 'update_job', { job_id: 'job-1' });
    check(noop.isError && /Nothing to update/.test(noop.text), 'update_job with no fields → error, no PATCH');

    const patchesBefore = requests.filter((x) => x.method === 'PATCH').length;
    const prev = await call(c, 'close_job', { job_id: 'job-1' });
    check(!prev.isError && prev.data?.preview === true && prev.data.job?.status === 'active', 'close_job without confirm → preview');
    check(requests.filter((x) => x.method === 'PATCH').length === patchesBefore, 'close_job preview: no PATCH sent');
    const closed = await call(c, 'close_job', { job_id: 'job-1', confirm: true });
    check(!closed.isError && closed.data?.closed === true && closed.data.job?.status === 'closed', 'close_job confirm → closed');
    check(requests.at(-1).method === 'PATCH' && requests.at(-1).body?.isActive === false, 'PATCH /jobs/:id {isActive:false}');
    const closedList = await call(c, 'my_jobs', { status: 'closed' });
    check(closedList.data?.jobs?.length === 1 && closedList.data.jobs[0].status === 'closed', 'my_jobs status=closed → shows it');
    const reopened = await call(c, 'update_job', { job_id: 'job-1', is_active: true });
    check(!reopened.isError && reopened.data?.job?.status === 'active', 'update_job is_active:true re-opens (job hidden publicly → found via /my-jobs fallback)');

    const apps = await call(c, 'job_applications', { job_id: 'job-1' });
    check(!apps.isError && apps.data?.applications?.length === 2 && apps.data.applications[0].job.id === 'job-1', 'job_applications job_id → 2 applications');
    check(apps.data?.applications?.[0]?.contact?.email === 'ml@example.com' && apps.data.applications[0].contact.linkedin && apps.data.applications[1].contact?.phone === undefined, 'contact fields: only what the API returned');
    const appsAll = await call(c, 'job_applications', { status: 'interview' });
    check(appsAll.data?.applications?.length === 1 && appsAll.data.applications[0].status === 'interview' && requests.at(-1).path === '/employer/applications', 'no job_id → /employer/applications; status filtered client-side');

    const cand = await call(c, 'search_candidates', { query: 'sales', country: 'AE', limit: 5 });
    check(!cand.isError && cand.data?.candidates?.length === 1 && cand.data.candidates[0].id === 'r-1', 'search_candidates query+country → 1 candidate');
    check(cand.data?.candidates?.[0]?.contact === null && cand.data.candidates[0].contact_access === false && cand.data.candidates[0].url === 'https://entracareers.com/ae/candidates/r-1', 'anonymised: contact null, profile url');
    const candSkills = await call(c, 'search_candidates', { skills: ['python', 'pytorch', 'nope-skill'] });
    check(candSkills.data?.candidates?.length === 1 && candSkills.data.candidates[0].contact?.email === 'ml@example.com' && candSkills.data.candidates[0].contact.phone === '+1 555 0100', 'skills search → hasFullAccess candidate with contact');
    check(/skills=sk-python&skills=sk-pytorch/.test(requests.at(-1).query) && /nope-skill/.test((candSkills.data?.notes ?? []).join(' ')), `skills as repeated keys (${requests.at(-1).query}); unresolved noted`);
    const sub = await call(c, 'search_candidates', { query: 'NEEDS_SUB' });
    check(!sub.isError && sub.data?.needs_subscription === true && sub.data?.note === 'Resume Access', 'resume 403 subscription → needs_subscription (Resume Access)');
    const empty = await call(c, 'search_candidates', {});
    check(empty.isError, 'search_candidates without filters → error');

    const match = await call(c, 'match_candidates', { job_id: 'job-1', limit: 5 });
    check(!match.isError && match.data?.matches?.length === 1 && match.data.matches[0].id === 'r-1' && match.data.matches[0].fit_score >= 90, `match_candidates job_id → r-1 fit ${match.data?.matches?.[0]?.fit_score}`);
    check(match.data?.queries_run?.length >= 2 && match.data.queries_run.length <= 3 && match.data.profile_used?.country_filter_applied === true, `${match.data?.queries_run?.length} queries, country filter for hybrid job`);
    check(Array.isArray(match.data?.matches?.[0]?.why) && match.data.matches[0].why.some((w) => /Located in United Arab Emirates/.test(w)) && /deterministic/.test(match.data?.note), 'why[] explains location; honesty note present');
    const matchText = await call(c, 'match_candidates', { job_text: 'Machine Learning Engineer\nRemote. Python, PyTorch, LLM fine-tuning. 6+ years of experience.', limit: 5 });
    check(matchText.data?.matches?.[0]?.id === 'r-2' && matchText.data.matches[0].fit_score >= 80 && matchText.data.profile_used?.remote === true, `match_candidates job_text → r-2 fit ${matchText.data?.matches?.[0]?.fit_score}`);

    const mine2 = requests.slice(start);
    check(!mine2.some((x) => PUBLIC(x.path, x.method) && x.auth), 'public endpoints (references, GET /jobs/:id) never received the bearer');
    check(mine2.every((x) => PUBLIC(x.path, x.method) || x.auth), 'every employer endpoint received the bearer');
    check(mine2.filter((x) => x.path === '/employer/api-keys/me').length === 1, 'whoami cached: /employer/api-keys/me called once');
    await c.close();
  }
} catch (e) {
  failed++;
  console.error('smoke-employer: error', e);
} finally {
  mock.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll employer smoke checks passed');
process.exit(failed ? 1 : 0);
