#!/usr/bin/env node
/**
 * ENTRA MCP Server — the first agent-ready job platform.
 * Wrapper over the ENTRA REST API (entracareers.com).
 *
 * Candidate mode (default, no key, read-only):
 *   search_jobs · get_job · list_companies · match_jobs · match_profile (alias)
 *   · salary_stats · companies_hiring · prepare_application
 *
 * Employer mode (ENTRA_API_KEY set — adds, never replaces):
 *   employer_whoami · post_job · my_jobs · close_job · update_job · job_applications
 *   · search_candidates · match_candidates
 *
 * Human-in-the-loop by design: agents find and rank, humans decide and apply.
 * Matching is deterministic (keyword dictionary + rules) — no LLM, no invented numbers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.3.1';
const API = (process.env.ENTRA_API_URL ?? 'https://entracareers.com/api').replace(/\/+$/, '');
const SITE = (process.env.ENTRA_SITE_URL ?? 'https://entracareers.com').replace(/\/+$/, '');
const UTM = 'utm_source=agent&utm_medium=mcp';
const SOURCE_NOTE = 'ENTRA — verified roles aggregated from company ATSs. Finds and ranks; you apply.';

// Employer mode: the key comes from the environment only (never from argv — argv leaks into process lists).
const RAW_API_KEY = (process.env.ENTRA_API_KEY ?? '').trim();
// MCPB hosts may hand over an unresolved "${user_config.…}" placeholder when the optional key is left blank — treat it as unset.
const API_KEY = RAW_API_KEY.startsWith('${') ? '' : RAW_API_KEY;
const EMPLOYER_FLAG = process.argv.includes('--employer');
const EMPLOYER_MODE = API_KEY.length > 0;
const API_KEYS_URL = `${SITE}/employer/profile?tab=api-keys`;
const PRICING_URL = `${SITE}/employer/pricing`;

// ---------- API layer ----------
type Json = Record<string, unknown>;
type ParamValue = string | number | boolean | undefined | null | Array<string | number>;
type Params = Record<string, ParamValue>;

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public hint: string | null = null,
    public validation: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SUBSCRIPTION_RE = /vacancy limit|subscription|upgrade your plan|resume database access/i;
const isSubscription403 = (e: unknown) => e instanceof ApiError && e.status === 403 && SUBSCRIPTION_RE.test(e.message);

function hintFor(status: number, message: string): string | null {
  if (status === 401) {
    return EMPLOYER_MODE
      ? `ENTRA_API_KEY was rejected (invalid or revoked). Create a new key at ${API_KEYS_URL} and restart the MCP server with the new ENTRA_API_KEY.`
      : `This endpoint needs an employer API key. Create one at ${API_KEYS_URL} and set ENTRA_API_KEY.`;
  }
  if (status === 403) {
    const scope = /required scope:\s*([a-z]+:[a-z]+)/i.exec(message)?.[1];
    if (scope) return `The API key lacks the "${scope}" scope. Create a key with that scope at ${API_KEYS_URL}.`;
    if (/not available with API key/i.test(message)) return 'This endpoint is not enabled for API keys (browser session only).';
    if (SUBSCRIPTION_RE.test(message)) return `Needs an active employer plan — see ${PRICING_URL}.`;
    return 'Forbidden — the key may belong to another company or the key owner lost the manager role.';
  }
  if (status === 429) return 'Rate limit: 120 requests/minute per API key. Wait a minute and retry (the server already retried once).';
  if (status === 400) return 'Validation failed — check the "validation" field for the offending fields.';
  return null;
}

type FetchOpts = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; params?: Params; body?: unknown; auth?: boolean };

/** One HTTP entry point. The bearer key is attached ONLY when `auth: true` (public routes reject keys by default). */
async function apiFetch<T = Json>(path: string, opts: FetchOpts = {}, attempt = 0): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `entra-mcp/${VERSION} (+${SITE})` };
  if (opts.auth) {
    if (!API_KEY) throw new ApiError(401, 'No ENTRA_API_KEY set', 'AUTH_ERROR', hintFor(401, ''));
    headers.authorization = `Bearer ${API_KEY}`;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429 && attempt === 0) {
    const ra = Number(res.headers.get('retry-after') ?? '1');
    const waitMs = Math.min(15_000, Math.max(250, (Number.isFinite(ra) ? ra : 1) * 1000));
    await new Promise((r) => setTimeout(r, waitMs));
    return apiFetch<T>(path, opts, 1);
  }
  if (!res.ok) {
    let body: Json = {};
    try {
      body = (await res.json()) as Json;
    } catch {
      /* body not JSON */
    }
    const detail = typeof body.message === 'string' ? body.message : '';
    const code = typeof body.code === 'string' ? body.code : null;
    throw new ApiError(
      res.status,
      `ENTRA API ${res.status} for ${opts.method ?? 'GET'} ${path}${detail ? `: ${detail}` : ''}`,
      code,
      hintFor(res.status, detail),
      body.validation,
    );
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

const apiGet = <T = Json>(path: string, params: Params = {}) => apiFetch<T>(path, { params });

type ExpLevel = 'no_experience' | '1_3_years' | '3_6_years' | '6_plus_years';
const EXP_ORDER: ExpLevel[] = ['no_experience', '1_3_years', '3_6_years', '6_plus_years'];
const EXP_LABEL: Record<ExpLevel, string> = {
  no_experience: 'entry level',
  '1_3_years': '1–3 yrs',
  '3_6_years': '3–6 yrs',
  '6_plus_years': '6+ yrs',
};
const isExpLevel = (v: unknown): v is ExpLevel => typeof v === 'string' && (EXP_ORDER as string[]).includes(v);

type ApiJob = {
  id: string;
  title: string;
  description?: string | null;
  requirements?: string | null;
  employmentType?: string | null;
  workLocation?: string | null;
  experienceLevel?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  company?: { id?: string; name?: string; slug?: string; isVerified?: boolean } | null;
  city?: { id?: string; nameEn?: string } | null;
  country?: { id?: string; nameEn?: string; slug?: string; code?: string } | null;
  specialization?: { id?: string; nameEn?: string; slug?: string } | null;
  skills?: Array<{ id?: string; nameEn?: string; name?: string; skill?: { id?: string; nameEn?: string } | null }> | null;
  publishedAt?: string | null;
  // employer-side fields (own jobs)
  companyId?: string | null;
  countryId?: string | null;
  cityId?: string | null;
  specializationId?: string | null;
  isActive?: boolean | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  benefits?: string[] | null;
  _count?: { applications?: number } | null;
};
type JobList = { data?: ApiJob[]; total?: number; page?: number; limit?: number; totalPages?: number };
type ApiCompany = {
  id: string;
  name: string;
  slug: string;
  isVerified?: boolean;
  jobsCount?: number;
  websiteUrl?: string | null;
  country?: { nameEn?: string } | null;
  city?: { nameEn?: string } | null;
};

// ---------- countries (ISO code ↔ ENTRA country id) ----------
type Country = { id: string; code: string; slug: string; name: string };
const codeById = new Map<string, string>();
const countryById = new Map<string, Country>();
let countriesPromise: Promise<Country[]> | null = null;

function loadCountries(): Promise<Country[]> {
  if (!countriesPromise) {
    countriesPromise = apiGet<{ data?: Array<{ id: string; code?: string; slug?: string; nameEn?: string }> }>(
      '/references/countries',
      { limit: 100, page: 1 },
    )
      .then((r) => {
        const list = (r.data ?? []).map((c) => ({
          id: c.id,
          code: (c.code ?? '').toUpperCase(),
          slug: c.slug ?? '',
          name: c.nameEn ?? '',
        }));
        for (const c of list) {
          if (c.code) codeById.set(c.id, c.code);
          countryById.set(c.id, c);
        }
        return list;
      })
      .catch(() => {
        countriesPromise = null; // retry next call
        return [] as Country[];
      });
  }
  return countriesPromise;
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'united states': 'US',
  'united states of america': 'US',
  america: 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  uae: 'AE',
  'united arab emirates': 'AE',
  emirates: 'AE',
  dubai: 'AE',
  deutschland: 'DE',
  holland: 'NL',
  'the netherlands': 'NL',
  'south korea': 'KR',
  korea: 'KR',
  'czech republic': 'CZ',
  czechia: 'CZ',
};

async function resolveCountry(input: string): Promise<Country | null> {
  const list = await loadCountries();
  const q = input.trim().toLowerCase();
  if (!q) return null;
  const code = (COUNTRY_ALIASES[q] ?? (q.length === 2 ? q : '')).toUpperCase();
  // ENTRA stores the United Kingdom as "UK" rather than ISO "GB" — accept both.
  const codes = code === 'GB' ? ['GB', 'UK'] : code === 'UK' ? ['UK', 'GB'] : code ? [code] : [];
  return (
    list.find((c) => codes.includes(c.code)) ??
    list.find((c) => c.slug === q || c.name.toLowerCase() === q) ??
    null
  );
}

async function unknownCountryMessage(input: string): Promise<string> {
  const codes = (await loadCountries()).map((c) => c.code).sort();
  return `Unknown country "${input}". Use an ISO-2 code${codes.length ? `: ${codes.join(', ')}` : ' (e.g. US, GB, DE, AE)'}.`;
}

// ---------- companies ----------
const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function resolveCompany(input: string): Promise<ApiCompany | null> {
  const slug = slugify(input);
  if (slug) {
    try {
      const r = await apiGet<{ data?: ApiCompany }>(`/companies/by-slug/${encodeURIComponent(slug)}`);
      if (r.data?.id) return r.data;
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 400)) throw e;
    }
  }
  const r = await apiGet<{ data?: ApiCompany[] }>('/companies', { search: input.trim(), limit: 5, page: 1 });
  const list = r.data ?? [];
  const q = input.trim().toLowerCase();
  return list.find((c) => c.name?.toLowerCase() === q || c.slug === slug) ?? list[0] ?? null;
}

const companyUrl = (slug?: string | null) => (slug ? `${SITE}/companies/${slug}?${UTM}` : null);

// ---------- formatting ----------
const PERIOD_PER_YEAR: Record<string, number> = { yearly: 1, monthly: 12, weekly: 52, daily: 260, hourly: 2080 };
const PERIOD_SUFFIX: Record<string, string> = { yearly: '/yr', monthly: '/mo', weekly: '/wk', daily: '/day', hourly: '/hr' };
const annualize = (v: number, period?: string | null) => Math.round(v * (PERIOD_PER_YEAR[period ?? 'monthly'] ?? 12));
const hasSalary = (j: ApiJob) => !!(j.salaryMin || j.salaryMax);
const annualMax = (j: ApiJob) => annualize(j.salaryMax ?? j.salaryMin ?? 0, j.salaryPeriod);
const kfmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function fmtSalary(j: ApiJob): string | null {
  const min = j.salaryMin ?? null;
  const max = j.salaryMax ?? null;
  if (!min && !max) return null;
  const cur = !j.salaryCurrency || j.salaryCurrency === 'USD' ? '$' : `${j.salaryCurrency} `;
  const range = min && max && min !== max ? `${cur}${kfmt(min)}–${kfmt(max)}` : `${cur}${kfmt((min ?? max) as number)}`;
  return range + (PERIOD_SUFFIX[j.salaryPeriod ?? 'monthly'] ?? '/mo');
}

const ccOf = (j: ApiJob) => (codeById.get(j.country?.id ?? j.countryId ?? '') ?? j.country?.code ?? 'us').toLowerCase();
const jobUrl = (j: ApiJob) => `${SITE}/${ccOf(j)}/vacancies/${j.id}?${UTM}`;

function compactJob(j: ApiJob) {
  return {
    id: j.id,
    title: j.title,
    company: j.company?.name ?? null,
    company_slug: j.company?.slug ?? null,
    company_verified: j.company?.isVerified ?? false,
    location: [j.city?.nameEn, j.country?.nameEn].filter(Boolean).join(', ') || 'Global',
    country_code: codeById.get(j.country?.id ?? '') ?? null,
    work_location: j.workLocation === 'office' ? 'onsite' : (j.workLocation ?? null),
    experience: j.experienceLevel ?? null,
    employment_type: j.employmentType ?? null,
    salary: fmtSalary(j),
    published_at: j.publishedAt ?? null,
    url: jobUrl(j),
    verified: true,
  };
}

// ---------- paginated fetch ----------
async function fetchJobs(
  params: Params,
  want: number,
  stopWhen?: (j: ApiJob) => boolean,
): Promise<{ jobs: ApiJob[]; total: number; stopped: boolean }> {
  const pageSize = Math.min(100, Math.max(1, want));
  const jobs: ApiJob[] = [];
  let total = 0;
  let page = 1;
  for (;;) {
    const res = await apiGet<JobList>('/jobs', { ...params, limit: pageSize, page });
    const data = res.data ?? [];
    total = res.total ?? data.length;
    for (const j of data) {
      if (stopWhen?.(j)) return { jobs, total, stopped: true };
      jobs.push(j);
      if (jobs.length >= want) return { jobs, total, stopped: false };
    }
    if (data.length < pageSize || page * pageSize >= total || page >= 10) return { jobs, total, stopped: false };
    page++;
  }
}

// ---------- deterministic keyword extraction ----------
// Each entry: [canonical, ...aliases]. Matched on word boundaries, case-insensitive.
const SKILL_DICT: string[][] = [
  ['python'], ['java'], ['javascript', 'js'], ['typescript', 'ts'],
  ['golang', 'go developer', 'go engineer', 'in go', 'with go', 'go/'],
  ['rust'], ['c++', 'cpp'], ['c#', 'csharp', '.net', 'dotnet', 'asp.net'], ['ruby', 'rails', 'ruby on rails'], ['php', 'laravel'],
  ['swift'], ['kotlin'], ['scala'], ['objective-c'], ['dart', 'flutter'], ['elixir'], ['erlang'], ['haskell'], ['clojure'], ['lua'],
  ['julia'], ['perl'], ['matlab'],
  ['sql'], ['nosql'], ['postgresql', 'postgres'], ['mysql'], ['mongodb', 'mongo'], ['redis'], ['elasticsearch', 'opensearch'],
  ['clickhouse'], ['cassandra'], ['dynamodb'], ['kafka'], ['rabbitmq'], ['spark', 'pyspark'], ['hadoop'], ['airflow'], ['dbt'],
  ['snowflake'], ['bigquery'], ['databricks'], ['redshift'],
  ['react', 'react.js', 'reactjs'], ['react native'], ['vue', 'vue.js', 'vuejs'], ['angular'], ['next.js', 'nextjs'],
  ['node.js', 'nodejs'], ['django'], ['flask'], ['fastapi'], ['spring boot', 'spring framework'], ['graphql'],
  ['rest api', 'rest apis', 'restful'], ['grpc'], ['websockets', 'websocket'], ['html'], ['css'], ['tailwind'], ['webpack'], ['vite'],
  ['docker'], ['kubernetes', 'k8s'], ['terraform'], ['ansible'], ['helm'], ['aws', 'amazon web services'], ['gcp', 'google cloud'],
  ['azure'], ['linux'], ['bash', 'shell scripting'], ['powershell'], ['ci/cd', 'cicd', 'ci cd', 'continuous integration'],
  ['jenkins'], ['github actions'], ['git'], ['gitlab'],
  ['pytorch'], ['tensorflow'], ['keras'], ['jax'], ['scikit-learn', 'sklearn'], ['pandas'], ['numpy'],
  ['hugging face', 'huggingface', 'transformers'], ['llm', 'llms', 'large language model', 'large language models'],
  ['rag', 'retrieval augmented generation', 'retrieval-augmented generation'], ['langchain'], ['llamaindex'],
  ['vector database', 'vector db', 'pinecone', 'weaviate', 'milvus', 'faiss', 'qdrant'], ['embeddings'],
  ['fine-tuning', 'fine tuning', 'finetuning'], ['prompt engineering'], ['ai agents', 'agentic', 'multi-agent', 'agent frameworks'],
  ['mcp', 'model context protocol'], ['evals', 'evaluation pipelines'], ['inference'], ['model training', 'training pipelines'],
  ['diffusion models', 'diffusion'], ['multimodal'], ['speech recognition', 'asr', 'text-to-speech', 'tts'],
  ['nlp', 'natural language processing'], ['computer vision'], ['deep learning'], ['machine learning', 'ml'],
  ['reinforcement learning', 'rl', 'rlhf'], ['mlops'], ['recommendation systems', 'recsys', 'recommender'],
  ['data pipelines'], ['etl'], ['data warehouse', 'data warehousing'], ['data modeling'], ['statistics', 'statistical modeling'],
  ['a/b testing', 'ab testing', 'experimentation'], ['tableau'], ['power bi'], ['looker'],
  ['cuda'], ['gpu', 'gpus'], ['distributed systems'], ['microservices'], ['system design'], ['high availability'],
  ['observability'], ['prometheus'], ['grafana'], ['datadog'], ['splunk'],
  ['security', 'application security', 'appsec'], ['cybersecurity', 'infosec'], ['penetration testing', 'pentest'], ['iam'],
  ['cryptography'], ['oauth'], ['sso', 'saml'], ['soc 2', 'soc2'], ['iso 27001'], ['gdpr'], ['compliance'],
  ['blockchain'], ['solidity'], ['web3'], ['ios'], ['android'], ['unity'], ['unreal'], ['opencv'], ['robotics'], ['ros'],
  ['embedded'], ['firmware'], ['fpga'], ['verilog'], ['rtl'], ['asic'], ['simulink'], ['autocad'], ['solidworks'],
  ['devops'], ['sre', 'site reliability'], ['networking', 'tcp/ip'], ['api design'], ['sdk'], ['open source', 'open-source'],
  ['technical writing'],
  ['jest'], ['cypress'], ['playwright'], ['selenium'], ['pytest'], ['junit'], ['test automation', 'automated testing'],
  ['manual testing'], ['qa', 'quality assurance'],
  ['figma'], ['ux', 'user experience'], ['ui', 'user interface'], ['product design'], ['design systems'], ['prototyping'],
  ['user research'], ['wireframing'],
  ['agile'], ['scrum'], ['jira'], ['kanban'], ['project management'], ['pmp'], ['program management'], ['product management'],
  ['roadmap'], ['stakeholder management'], ['okrs'],
  ['go-to-market', 'gtm'], ['growth'], ['b2b'], ['saas'], ['enterprise sales'], ['partnerships'], ['salesforce'], ['hubspot'],
  ['crm'], ['outbound'], ['cold calling'], ['lead generation'], ['pipeline generation'], ['quota'], ['account management'],
  ['customer success'], ['customer support'], ['technical support'], ['zendesk'],
  ['seo'], ['sem'], ['google analytics'], ['content marketing'], ['copywriting'], ['social media'], ['paid media', 'paid ads', 'ppc'],
  ['email marketing'], ['brand marketing'], ['video editing'], ['photoshop'], ['illustrator'], ['after effects'], ['premiere'],
  ['motion graphics'], ['3d modeling', 'blender'],
  ['recruiting', 'recruitment', 'talent acquisition', 'sourcing'], ['hr', 'human resources'], ['payroll'], ['accounting'], ['gaap'],
  ['ifrs'], ['audit'], ['tax'], ['financial modeling'], ['fp&a'], ['legal'], ['supply chain'], ['logistics'], ['procurement'],
  ['lean manufacturing', 'lean six sigma'], ['six sigma'],
  ['fintech'], ['payments'], ['healthcare'], ['biotech'], ['genomics'], ['clinical'], ['e-commerce', 'ecommerce'], ['gaming'],
  ['edtech'], ['adtech'], ['insurance'], ['real estate'],
];

const ROLE_DICT: string[][] = [
  ['machine learning engineer', 'ml engineer', 'mle', 'machine learning scientist'],
  ['ai engineer', 'artificial intelligence engineer', 'genai engineer', 'llm engineer'],
  ['research engineer'], ['research scientist', 'applied scientist', 'ai researcher'],
  ['data scientist'], ['data engineer'], ['data analyst'], ['analytics engineer'], ['business analyst'], ['financial analyst'],
  ['software engineer', 'software developer', 'swe', 'sde'],
  ['backend engineer', 'backend developer', 'back-end engineer', 'back end engineer', 'back-end developer'],
  ['frontend engineer', 'frontend developer', 'front-end engineer', 'front end engineer', 'front-end developer'],
  ['full stack engineer', 'full-stack engineer', 'fullstack engineer', 'full stack developer', 'full-stack developer'],
  ['mobile engineer', 'mobile developer'], ['ios engineer', 'ios developer'], ['android engineer', 'android developer'],
  ['devops engineer'], ['site reliability engineer', 'sre'], ['platform engineer'], ['infrastructure engineer'], ['cloud engineer'],
  ['security engineer'], ['qa engineer', 'quality assurance engineer', 'test engineer', 'sdet'],
  ['embedded engineer', 'firmware engineer'], ['hardware engineer'],
  ['solutions engineer', 'solutions architect', 'sales engineer', 'forward deployed engineer'], ['software architect'],
  ['engineering manager'], ['product manager'], ['project manager'], ['program manager'], ['technical program manager', 'tpm'],
  ['product designer'], ['ux designer', 'ux/ui designer', 'ui/ux designer'], ['ui designer'], ['graphic designer'],
  ['ux researcher', 'user researcher'], ['technical writer'],
  ['account executive'], ['sales development representative', 'sdr', 'business development representative', 'bdr'],
  ['account manager'], ['customer success manager'], ['sales manager'], ['business development manager'],
  ['recruiter', 'talent acquisition'], ['hr manager', 'people operations'], ['marketing manager'],
  ['growth marketer', 'growth manager'], ['content marketer', 'content manager'], ['community manager'],
  ['product marketing manager'], ['operations manager'], ['chief of staff'], ['accountant'], ['controller'], ['finance manager'],
];

const reCache = new Map<string, RegExp>();
function termRegex(term: string, flags = 'i'): RegExp {
  const key = `${flags}:${term}`;
  let re = reCache.get(key);
  if (!re) {
    const esc = term
      .trim()
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s-]+');
    re = new RegExp(`(?<![a-z0-9+#])${esc}(?![a-z0-9+#])`, flags);
    reCache.set(key, re);
  }
  return re;
}

type Found = { term: string; count: number; first: number };
function extractTerms(text: string, dict: string[][]): Found[] {
  const t = text.toLowerCase();
  const out: Found[] = [];
  for (const entry of dict) {
    let count = 0;
    let first = Infinity;
    for (const alias of entry) {
      const re = new RegExp(termRegex(alias).source, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        count++;
        first = Math.min(first, m.index);
      }
    }
    if (count) out.push({ term: entry[0], count, first });
  }
  return out.sort((a, b) => b.count - a.count || a.first - b.first);
}

function canonicalSkill(s: string): string {
  const q = s.trim().toLowerCase();
  for (const e of SKILL_DICT) if (e.includes(q)) return e[0];
  return q;
}

function detectSeniority(text: string): { level: ExpLevel; basis: string } | null {
  const t = text.toLowerCase();
  const years = [...t.matchAll(/(\d{1,2})\s*\+?\s*(?:years|yrs|year)\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 45);
  if (years.length) {
    const y = Math.max(...years);
    const level: ExpLevel = y >= 6 ? '6_plus_years' : y >= 3 ? '3_6_years' : y >= 1 ? '1_3_years' : 'no_experience';
    return { level, basis: `${y}${y >= 6 ? '+' : ''} years mentioned` };
  }
  if (/\b(staff|principal|distinguished|director|head of|vp|cto|tech lead|team lead)\b/.test(t))
    return { level: '6_plus_years', basis: 'staff/lead/director title' };
  if (/\b(senior|sr\.?)\b/.test(t)) return { level: '3_6_years', basis: 'senior title' };
  if (/\b(junior|jr\.?)\b/.test(t)) return { level: '1_3_years', basis: 'junior title' };
  if (/\b(intern|internship|student|graduate|entry[- ]level)\b/.test(t)) return { level: 'no_experience', basis: 'entry-level signal' };
  return null;
}

function jobLevel(j: ApiJob): ExpLevel | null {
  if (isExpLevel(j.experienceLevel)) return j.experienceLevel;
  const t = (j.title ?? '').toLowerCase();
  if (/\b(staff|principal|distinguished|director|head of|vp|lead)\b/.test(t)) return '6_plus_years';
  if (/\b(senior|sr\.?)\b/.test(t)) return '3_6_years';
  if (/\b(junior|jr\.?)\b/.test(t)) return '1_3_years';
  if (/\b(intern|internship|graduate|entry[- ]level)\b/.test(t)) return 'no_experience';
  return null;
}

const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'at', 'to', 'with', 'senior', 'junior', 'staff', 'lead', 'principal', 'sr',
  'jr', 'ii', 'iii', 'iv', 'i', 'level', 'mid', 'intern', 'remote', 'hybrid', 'onsite', 'new', 'grad',
]);
const TOKEN_SYN: Record<string, string> = {
  developer: 'engineer', dev: 'engineer', programmer: 'engineer', engineering: 'engineer', engineers: 'engineer',
  ml: 'machine learning', mle: 'machine learning engineer', swe: 'software engineer', sde: 'software engineer',
  sre: 'site reliability engineer', 'front-end': 'frontend', 'back-end': 'backend', 'full-stack': 'full stack',
  fullstack: 'full stack', mgr: 'manager', pm: 'product manager', tpm: 'technical program manager',
  sdr: 'sales development representative', ai: 'ai', genai: 'ai', scientists: 'scientist',
};
function roleTokens(s: string): string[] {
  const norm = s.toLowerCase().replace(/[^a-z0-9+#.\s/-]/g, ' ');
  const words = norm
    .split(/[\s/,]+/)
    .filter(Boolean)
    .map((w) => TOKEN_SYN[w] ?? w)
    .join(' ')
    .split(/\s+/);
  return [...new Set(words.filter((w) => w && !STOP.has(w)))];
}

// ---------- scoring (explainable, 0–100) ----------
type Profile = { skills: string[]; role: string | null; seniority: ExpLevel | null; remoteOnly: boolean; country: Country | null };
type Scored = { job: ApiJob; score: number; why: string[]; matched: string[]; gaps: string[] };

function scoreJob(j: ApiJob, p: Profile): Scored {
  const why: string[] = [];
  let earned = 0;
  let possible = 0;
  const title = j.title ?? '';
  const titleLower = title.toLowerCase();
  const text = [
    title,
    j.description ?? '',
    j.requirements ?? '',
    (j.skills ?? []).map((s) => s.nameEn ?? s.name ?? '').join(' '),
  ]
    .join('\n')
    .toLowerCase();

  const matched: string[] = [];
  const inTitle: string[] = [];
  const gaps: string[] = [];
  const skills = p.skills.slice(0, 12);
  if (skills.length) {
    possible += 50;
    for (const s of skills) {
      const re = termRegex(s);
      if (re.test(text)) {
        matched.push(s);
        if (re.test(titleLower)) inTitle.push(s);
      } else gaps.push(s);
    }
    earned += Math.min(50, Math.round((50 * matched.length) / skills.length) + (inTitle.length ? 5 : 0));
    why.push(
      matched.length
        ? `Skills: ${matched.length}/${skills.length} matched (${matched.join(', ')})`
        : `Skills: none of ${skills.length} found in the listing`,
    );
    if (inTitle.length) why.push(`In the job title: ${inTitle.join(', ')}`);
  }

  if (p.role) {
    possible += 25;
    const rt = roleTokens(p.role);
    const tt = new Set(roleTokens(title));
    const hit = rt.filter((t) => tt.has(t));
    const frac = rt.length ? hit.length / rt.length : 0;
    let pts = Math.round(25 * frac);
    if (!pts && termRegex(p.role).test(text)) pts = 5;
    earned += pts;
    why.push(
      frac >= 0.99
        ? `Title match: "${title}" fits "${p.role}"`
        : frac > 0
          ? `Partial title match (${Math.round(frac * 100)}%): "${title}" vs "${p.role}"`
          : pts
            ? `Role "${p.role}" mentioned in the description, not the title`
            : `Title "${title}" does not match "${p.role}"`,
    );
  }

  if (p.seniority) {
    possible += 10;
    const jl = jobLevel(j);
    if (jl) {
      const d = Math.abs(EXP_ORDER.indexOf(jl) - EXP_ORDER.indexOf(p.seniority));
      earned += d === 0 ? 10 : d === 1 ? 5 : 0;
      why.push(
        `Seniority: job asks ${EXP_LABEL[jl]}, you read as ${EXP_LABEL[p.seniority]} — ${d === 0 ? 'match' : d === 1 ? 'close' : 'mismatch'}`,
      );
    } else {
      earned += 5;
      why.push('Seniority: not specified by the job');
    }
  }

  if (p.remoteOnly || p.country) {
    possible += 10;
    const remoteOk = !p.remoteOnly || j.workLocation === 'remote';
    const countryOk = !p.country || j.country?.id === p.country.id;
    earned += remoteOk && countryOk ? 10 : remoteOk || countryOk ? 5 : 0;
    if (p.remoteOnly) why.push(remoteOk ? 'Remote role (as requested)' : `Not remote (${j.workLocation ?? 'unspecified'})`);
    if (p.country)
      why.push(
        countryOk
          ? `Located in ${p.country.name} (as requested)`
          : `Located in ${j.country?.nameEn ?? 'unspecified'}, not ${p.country.name}`,
      );
  } else if (j.workLocation === 'remote') {
    why.push('Remote role');
  }

  possible += 5;
  const sal = fmtSalary(j);
  if (sal) {
    earned += 5;
    why.push(`Salary band listed: ${sal}`);
  } else why.push('No salary band listed');

  const score = possible ? Math.round((100 * earned) / possible) : 0;
  return { job: j, score, why, matched, gaps: gaps.slice(0, 5) };
}

const chanceHint = (score: number): 'high' | 'medium' | 'low' => (score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low');
const byScoreThenDate = (a: Scored, b: Scored) =>
  b.score - a.score || Date.parse(b.job.publishedAt ?? '') - Date.parse(a.job.publishedAt ?? '') || 0;
const rankByFit = (jobs: ApiJob[], p: Profile) => jobs.map((j) => scoreJob(j, p)).sort(byScoreThenDate);
const withFit = (s: Scored) => ({
  ...compactJob(s.job),
  fit_score: s.score,
  interview_chance_hint: chanceHint(s.score),
  why: s.why,
  matched_skills: s.matched,
  skill_gaps: s.gaps,
});
const FIT_NOTE =
  'fit_score is a deterministic keyword/rules score (0–100), not a prediction. interview_chance_hint is derived from fit_score only (high ≥75, medium ≥50, low <50).';

// ---------- tool results ----------
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (o: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (message: string, extra: Json = {}): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  isError: true,
});
/** Structured error for API failures: { error, code, status, hint, validation? }. */
const failApi = (e: ApiError): ToolResult =>
  fail(e.message, {
    code: e.code ?? (e.status === 401 ? 'AUTH_ERROR' : e.status === 403 ? 'FORBIDDEN' : e.status === 429 ? 'RATE_LIMITED' : `HTTP_${e.status}`),
    status: e.status,
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.validation !== undefined ? { validation: e.validation } : {}),
  });
const guarded =
  <A>(fn: (a: A) => Promise<ToolResult>) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof ApiError) return failApi(e);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

// ---------- schemas ----------
const experienceEnum = z.enum(['no_experience', '1_3_years', '3_6_years', '6_plus_years']);

const searchShape = {
  query: z.string().min(1).describe('Free-text search, e.g. "machine learning engineer"'),
  work_location: z.enum(['remote', 'onsite', 'hybrid']).optional().describe('Filter by work location'),
  remote: z.boolean().optional().describe('Shorthand for work_location="remote"'),
  country: z.string().optional().describe('ISO-2 country code (US, GB, DE, AE…) or country name'),
  company: z.string().optional().describe('Company slug or name, e.g. "openai" or "Stripe"'),
  salary_min: z.number().min(0).optional().describe('Minimum ANNUAL salary (default currency USD; ENTRA converts other currencies)'),
  salary_currency: z.string().length(3).optional().describe('Currency for salary_min (default USD)'),
  experience: experienceEnum.optional().describe('Experience level'),
  posted_within_days: z.number().int().min(1).max(365).optional().describe('Only roles published in the last N days'),
  rank_by: z.enum(['date', 'salary', 'fit']).optional().describe('date (default) · salary (listed bands only, high→low) · fit (needs profile_keywords)'),
  profile_keywords: z.array(z.string()).max(30).optional().describe('Candidate skills for rank_by="fit", e.g. ["python","pytorch","llm"]'),
  sort_by_salary: z.boolean().optional().describe('Deprecated — use rank_by="salary"'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10, max 50)'),
};
type SearchArgs = z.infer<z.ZodObject<typeof searchShape>>;

const matchShape = {
  resume_text: z.string().max(8000).optional().describe('Free-text resume / profile (≤8000 chars). Skills, role and seniority are extracted deterministically.'),
  skills: z.array(z.string()).max(50).optional().describe('Key skills if you have no resume text, e.g. ["python","llm","rag"]'),
  target_role: z.string().optional().describe('Target role, e.g. "machine learning engineer" (overrides the role detected in resume_text)'),
  remote_only: z.boolean().optional().describe('Only remote roles'),
  country: z.string().optional().describe('ISO-2 country code or country name'),
  min_salary: z.number().min(0).optional().describe('Minimum ANNUAL salary in USD'),
  limit: z.number().int().min(1).max(20).optional().describe('Max matches (default 10, max 20)'),
};
type MatchArgs = z.infer<z.ZodObject<typeof matchShape>>;

const salaryShape = {
  query: z.string().min(1).describe('Role query, e.g. "machine learning engineer"'),
  country: z.string().optional().describe('ISO-2 country code or country name'),
  remote_only: z.boolean().optional().describe('Only remote roles'),
  experience: experienceEnum.optional().describe('Experience level'),
};
type SalaryArgs = z.infer<z.ZodObject<typeof salaryShape>>;

const hiringShape = {
  query: z.string().min(1).describe('Role query, e.g. "AI engineer"'),
  country: z.string().optional().describe('ISO-2 country code or country name'),
  remote_only: z.boolean().optional().describe('Only remote roles'),
  limit: z.number().int().min(1).max(25).optional().describe('Max companies (default 15, max 25)'),
};
type HiringArgs = z.infer<z.ZodObject<typeof hiringShape>>;

// ---------- tool implementations ----------
async function applyCommonFilters(
  params: Params,
  a: { country?: string; remote_only?: boolean; experience?: ExpLevel },
): Promise<{ country: Country | null; error?: string }> {
  let country: Country | null = null;
  if (a.country) {
    country = await resolveCountry(a.country);
    if (!country) return { country: null, error: await unknownCountryMessage(a.country) };
    params.countryId = country.id;
  }
  if (a.remote_only) params.workLocation = 'remote';
  if (a.experience) params.experienceLevel = a.experience;
  return { country };
}

async function runSearchJobs(a: SearchArgs): Promise<ToolResult> {
  await loadCountries();
  const limit = a.limit ?? 10;
  const params: Params = { search: a.query, experienceLevel: a.experience };
  const wl = a.work_location ?? (a.remote ? 'remote' : undefined);
  if (wl) params.workLocation = wl === 'onsite' ? 'office' : wl;
  if (a.salary_min) {
    params.salaryMin = Math.round(a.salary_min);
    params.salaryPeriod = 'yearly';
    params.salaryCurrency = (a.salary_currency ?? 'USD').toUpperCase();
  }
  let country: Country | null = null;
  if (a.country) {
    country = await resolveCountry(a.country);
    if (!country) return fail(await unknownCountryMessage(a.country));
    params.countryId = country.id;
  }
  let company: ApiCompany | null = null;
  if (a.company) {
    company = await resolveCompany(a.company);
    if (!company) return fail(`Company "${a.company}" not found on ENTRA. Use list_companies to find the slug.`);
    params.companyId = company.id;
  }
  const rankBy = a.rank_by ?? (a.sort_by_salary ? 'salary' : 'date');
  if (rankBy === 'fit' && !a.profile_keywords?.length) {
    return fail('rank_by="fit" requires profile_keywords, e.g. ["python","pytorch","llm"]');
  }
  const profile: Profile = {
    skills: (a.profile_keywords ?? []).map(canonicalSkill),
    role: a.query,
    seniority: null,
    remoteOnly: false,
    country: null,
  };

  const notes: string[] = [];
  let total = 0;
  let out: Array<ReturnType<typeof compactJob> | ReturnType<typeof withFit>> = [];

  if (a.posted_within_days) {
    const cutoff = Date.now() - a.posted_within_days * 86_400_000;
    const r = await fetchJobs(
      { ...params, sortBy: 'publishedAt', sortOrder: 'desc' },
      500,
      (j) => !!j.publishedAt && Date.parse(j.publishedAt) < cutoff,
    );
    let pool = r.jobs;
    notes.push(`filtered client-side to roles published in the last ${a.posted_within_days} day(s)`);
    if (!r.stopped && pool.length >= 500) notes.push('total_found is a lower bound (scan capped at the 500 most recent matches)');
    if (rankBy === 'salary') {
      pool = pool.filter(hasSalary).sort((x, y) => annualMax(y) - annualMax(x));
      notes.push('salaried listings only (rank_by=salary)');
    }
    total = pool.length;
    out = rankBy === 'fit' ? rankByFit(pool, profile).slice(0, limit).map(withFit) : pool.slice(0, limit).map(compactJob);
  } else if (rankBy === 'salary') {
    if (!params.salaryMin) {
      params.salaryMin = 1;
      params.salaryPeriod = 'yearly';
      params.salaryCurrency = 'USD';
    }
    const r = await fetchJobs({ ...params, sortBy: 'salary', sortOrder: 'desc' }, limit);
    total = r.total;
    notes.push('salaried listings only (rank_by=salary)');
    out = r.jobs.map(compactJob);
  } else if (rankBy === 'fit') {
    const r = await fetchJobs({ ...params, sortBy: 'publishedAt', sortOrder: 'desc' }, Math.min(100, Math.max(60, limit * 4)));
    total = r.total;
    notes.push(`fit ranked client-side over the ${r.jobs.length} most recent matches`);
    out = rankByFit(r.jobs, profile).slice(0, limit).map(withFit);
  } else {
    const r = await fetchJobs({ ...params, sortBy: 'publishedAt', sortOrder: 'desc' }, limit);
    total = r.total;
    out = r.jobs.map(compactJob);
  }

  return ok({
    source: SOURCE_NOTE,
    query: a.query,
    filters: {
      work_location: wl ?? null,
      country: country ? `${country.name} (${country.code})` : null,
      company: company ? { name: company.name, slug: company.slug, url: companyUrl(company.slug) } : null,
      salary_min: a.salary_min ? `${a.salary_min} ${(a.salary_currency ?? 'USD').toUpperCase()}/yr` : null,
      experience: a.experience ?? null,
      posted_within_days: a.posted_within_days ?? null,
    },
    rank_by: rankBy,
    total_found: total,
    returned: out.length,
    ...(notes.length ? { notes } : {}),
    ...(rankBy === 'fit' ? { fit_note: FIT_NOTE } : {}),
    jobs: out,
  });
}

async function runMatchJobs(a: MatchArgs): Promise<ToolResult> {
  const resume = a.resume_text?.trim() ?? '';
  const given = (a.skills ?? []).map(canonicalSkill).filter(Boolean);
  if (!resume && !given.length) return fail('Provide resume_text (free text) or skills[] — at least one is required.');
  await loadCountries();

  const found = resume ? extractTerms(resume, SKILL_DICT) : [];
  const skills = [...new Set([...given, ...found.map((f) => f.term)])].slice(0, 25);
  const roles = resume ? extractTerms(resume, ROLE_DICT) : [];
  const headlineRole = roles.filter((r) => r.first < 800).sort((x, y) => x.first - y.first)[0];
  const detectedRole = headlineRole?.term ?? roles[0]?.term ?? null;
  const role = a.target_role?.trim() || detectedRole;
  const seniority = resume ? detectSeniority(resume) : null;

  const params: Params = { sortBy: 'publishedAt', sortOrder: 'desc' };
  const f = await applyCommonFilters(params, { country: a.country, remote_only: a.remote_only });
  if (f.error) return fail(f.error);
  if (a.min_salary) {
    params.salaryMin = Math.round(a.min_salary);
    params.salaryPeriod = 'yearly';
    params.salaryCurrency = 'USD';
  }

  const queries: string[] = [];
  if (role) queries.push(role);
  for (const s of skills) {
    if (queries.length >= 4) break;
    if (s.length < 2 || queries.includes(s)) continue;
    if (role && termRegex(s).test(role)) continue; // already covered by the role query
    queries.push(s);
  }
  if (!queries.length) return fail('Could not derive any search terms. Add a target_role or list a few skills.');

  const results = await Promise.all(queries.map((q) => fetchJobs({ ...params, search: q }, 50)));
  const seen = new Map<string, ApiJob>();
  for (const r of results) for (const j of r.jobs) if (!seen.has(j.id)) seen.set(j.id, j);

  const profile: Profile = { skills, role, seniority: seniority?.level ?? null, remoteOnly: !!a.remote_only, country: f.country };
  const ranked = rankByFit([...seen.values()], profile).slice(0, a.limit ?? 10);

  return ok({
    source: SOURCE_NOTE,
    profile: {
      skills_used: skills.slice(0, 12),
      skills_detected_total: skills.length,
      target_role: role,
      role_source: a.target_role?.trim() ? 'target_role' : detectedRole ? 'detected in resume_text' : null,
      seniority: seniority ? `${EXP_LABEL[seniority.level]} (${seniority.basis})` : null,
      remote_only: !!a.remote_only,
      country: f.country ? `${f.country.name} (${f.country.code})` : null,
      min_salary: a.min_salary ? `${a.min_salary} USD/yr` : null,
    },
    queries_run: queries,
    candidates_considered: seen.size,
    matches: ranked.map(withFit),
    note: FIT_NOTE,
  });
}

async function runSalaryStats(a: SalaryArgs): Promise<ToolResult> {
  await loadCountries();
  const params: Params = {
    search: a.query,
    salaryMin: 1,
    salaryPeriod: 'yearly',
    salaryCurrency: 'USD',
    sortBy: 'publishedAt',
    sortOrder: 'desc',
  };
  const f = await applyCommonFilters(params, a);
  if (f.error) return fail(f.error);

  const r = await fetchJobs(params, 150);
  const jobs = r.jobs.filter(hasSalary);
  const filters = {
    country: f.country ? `${f.country.name} (${f.country.code})` : null,
    remote_only: !!a.remote_only,
    experience: a.experience ?? null,
  };
  const NOTE =
    'Stats are computed from listed salary bands only — roles without a published band are excluded. Values are annualized (yearly as-is; monthly×12; weekly×52; daily×260; hourly×2080). Non-USD currencies are reported in their own currency, no FX conversion.';
  if (!jobs.length) {
    return ok({ source: SOURCE_NOTE, query: a.query, filters, count_with_salary: 0, by_currency: [], top_companies: [], note: NOTE });
  }

  const groups = new Map<string, { mins: number[]; maxs: number[]; mids: number[] }>();
  for (const j of jobs) {
    const cur = (j.salaryCurrency ?? 'USD').toUpperCase();
    const lo = annualize(j.salaryMin ?? (j.salaryMax as number), j.salaryPeriod);
    const hi = annualize(j.salaryMax ?? (j.salaryMin as number), j.salaryPeriod);
    const g = groups.get(cur) ?? { mins: [], maxs: [], mids: [] };
    g.mins.push(lo);
    g.maxs.push(hi);
    g.mids.push(Math.round((lo + hi) / 2));
    groups.set(cur, g);
  }
  const nearestRank = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  const median = (sorted: number[]) => {
    const n = sorted.length;
    return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  };
  const by_currency = [...groups.entries()]
    .map(([currency, g]) => {
      const mids = [...g.mids].sort((x, y) => x - y);
      return {
        currency,
        count: mids.length,
        period: 'yearly (annualized)',
        usd_equivalent: currency === 'USD',
        min: Math.min(...g.mins),
        p25: nearestRank(mids, 0.25),
        median: median(mids),
        p75: nearestRank(mids, 0.75),
        max: Math.max(...g.maxs),
        basis: 'min = lowest listed band floor · median/p25/p75 = band midpoints · max = highest listed band ceiling',
      };
    })
    .sort((x, y) => y.count - x.count);

  const companyCount = new Map<string, { name: string; slug: string | null; verified: boolean; count: number }>();
  for (const j of jobs) {
    const key = j.company?.slug ?? j.company?.name ?? 'unknown';
    const c = companyCount.get(key) ?? { name: j.company?.name ?? 'Unknown', slug: j.company?.slug ?? null, verified: j.company?.isVerified ?? false, count: 0 };
    c.count++;
    companyCount.set(key, c);
  }
  const top_companies = [...companyCount.values()]
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    .slice(0, 5)
    .map((c) => ({ name: c.name, roles_with_salary: c.count, verified: c.verified, url: companyUrl(c.slug) }));

  return ok({
    source: SOURCE_NOTE,
    query: a.query,
    filters,
    count_with_salary: r.total,
    sample_size: jobs.length,
    sample: r.total > jobs.length ? `${jobs.length} most recent salaried listings of ${r.total}` : 'all salaried listings that matched',
    by_currency,
    top_companies,
    note: NOTE,
  });
}

async function runCompaniesHiring(a: HiringArgs): Promise<ToolResult> {
  await loadCountries();
  const params: Params = { search: a.query, sortBy: 'publishedAt', sortOrder: 'desc' };
  const f = await applyCommonFilters(params, a);
  if (f.error) return fail(f.error);
  const r = await fetchJobs(params, 300);

  type Agg = { name: string; slug: string | null; verified: boolean; count: number; titles: string[]; latest: string | null };
  const agg = new Map<string, Agg>();
  for (const j of r.jobs) {
    const key = j.company?.slug ?? j.company?.name ?? 'unknown';
    const c = agg.get(key) ?? {
      name: j.company?.name ?? 'Unknown',
      slug: j.company?.slug ?? null,
      verified: j.company?.isVerified ?? false,
      count: 0,
      titles: [],
      latest: null,
    };
    c.count++;
    if (c.titles.length < 3 && !c.titles.includes(j.title)) c.titles.push(j.title);
    if (j.publishedAt && (!c.latest || j.publishedAt > c.latest)) c.latest = j.publishedAt;
    agg.set(key, c);
  }
  const companies = [...agg.values()]
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    .slice(0, a.limit ?? 15)
    .map((c) => ({
      name: c.name,
      slug: c.slug,
      verified: c.verified,
      open_roles_matching: c.count,
      sample_titles: c.titles,
      latest_posted: c.latest,
      url: companyUrl(c.slug),
    }));

  return ok({
    source: SOURCE_NOTE,
    query: a.query,
    filters: { country: f.country ? `${f.country.name} (${f.country.code})` : null, remote_only: !!a.remote_only },
    total_matching_jobs: r.total,
    jobs_scanned: r.jobs.length,
    coverage: r.total > r.jobs.length ? `counts from the ${r.jobs.length} most recent of ${r.total} matching roles` : 'exact — all matching roles scanned',
    companies_found: agg.size,
    companies,
  });
}

async function runGetJob(job_id: string): Promise<ToolResult> {
  await loadCountries();
  const res = await apiGet<{ data?: ApiJob }>(`/jobs/${encodeURIComponent(job_id)}`);
  const j = (res.data ?? (res as unknown)) as ApiJob;
  return ok({
    source: SOURCE_NOTE,
    job: {
      ...compactJob(j),
      specialization: j.specialization?.nameEn ?? null,
      skills: (j.skills ?? []).map((s) => s.nameEn ?? s.name).filter(Boolean),
      description: (j.description ?? '').slice(0, 4000),
      requirements: (j.requirements ?? '').slice(0, 2000) || null,
    },
  });
}

async function runListCompanies(a: { query?: string; limit?: number }): Promise<ToolResult> {
  const res = await apiGet<{ data?: ApiCompany[]; total?: number }>('/companies', { search: a.query, limit: a.limit ?? 20, page: 1 });
  const companies = (res.data ?? []).map((c) => ({
    name: c.name,
    slug: c.slug,
    verified: c.isVerified ?? false,
    open_roles: c.jobsCount ?? null,
    location: [c.city?.nameEn, c.country?.nameEn].filter(Boolean).join(', ') || null,
    website: c.websiteUrl ?? null,
    url: companyUrl(c.slug),
  }));
  return ok({ source: SOURCE_NOTE, total_found: res.total ?? companies.length, companies });
}

async function runPrepareApplication(job_id: string): Promise<ToolResult> {
  await loadCountries();
  const res = await apiGet<{ data?: ApiJob }>(`/jobs/${encodeURIComponent(job_id)}`);
  const j = (res.data ?? (res as unknown)) as ApiJob;
  return ok({
    job: `${j.title} @ ${j.company?.name ?? 'company'}`,
    apply_url: jobUrl(j),
    checklist: [
      'Create a free ENTRA profile (one profile → every AI company)',
      'Attach your resume; connect GitHub for a verified skills Passport',
      j.requirements ? 'Check the requirements below before applying' : 'Review the role description',
      'Apply on the page — takes ~2 minutes',
    ],
    requirements_excerpt: (j.requirements ?? j.description ?? '').slice(0, 800),
    note: 'ENTRA is agent-ready: agents search and prepare, humans decide and apply. No auto-submission.',
  });
}

// =====================================================================
// ---------- EMPLOYER MODE (ENTRA_API_KEY) ----------
// =====================================================================
type Scope = 'jobs:read' | 'jobs:write' | 'applications:read' | 'candidates:read';
type MeCompany = { id: string; name?: string; slug?: string };
type Me = {
  authMethod?: string;
  user?: { id?: string; email?: string; firstName?: string; lastName?: string; role?: string } | null;
  apiKey?: { id?: string; name?: string; keyPrefix?: string; scopes?: string[] } | null;
  company?: MeCompany | null;
};
let mePromise: Promise<Me> | null = null;

/** Lazy + cached: GET /employer/api-keys/me. Never called at startup; a failure is not cached. */
function whoami(): Promise<Me> {
  if (!mePromise) {
    mePromise = apiFetch<{ data?: Me }>('/employer/api-keys/me', { auth: true })
      .then((r) => {
        const me = (r.data ?? (r as unknown)) as Me;
        if (!me.company?.id) {
          throw new ApiError(403, 'API key is not bound to a company', 'FORBIDDEN', `Re-create the key at ${API_KEYS_URL} while managing a company.`);
        }
        return me;
      })
      .catch((e: unknown) => {
        mePromise = null;
        throw e;
      });
  }
  return mePromise;
}

function scopeError(me: Me, scope: Scope): string | null {
  const scopes = me.apiKey?.scopes;
  if (!Array.isArray(scopes)) return null; // scopes unknown → let the API decide
  if (scopes.includes(scope)) return null;
  return `API key ${me.apiKey?.keyPrefix ?? ''} lacks the "${scope}" scope (has: ${scopes.join(', ') || 'none'}). Create a key with ${scope} at ${API_KEYS_URL}.`;
}

type EmployerCtx = { me: Me; company: MeCompany };
async function employerContext(scope: Scope): Promise<EmployerCtx | { error: ToolResult }> {
  const me = await whoami();
  const err = scopeError(me, scope);
  if (err) return { error: fail(err, { code: 'MISSING_SCOPE', scope, hint: API_KEYS_URL }) };
  return { me, company: me.company as MeCompany };
}
const isCtxError = (c: EmployerCtx | { error: ToolResult }): c is { error: ToolResult } => 'error' in c;

const needsSubscription = (product: string, e: ApiError) =>
  ok({
    needs_subscription: true,
    pricing_url: PRICING_URL,
    note: product === 'jobs' ? 'Founding plan from $10' : 'Resume Access',
    message: e.message.replace(/^ENTRA API \d+ for [A-Z]+ \S+: /, ''),
  });

// ---------- reference resolvers (public endpoints, no key) ----------
type Ref = { id: string; nameEn?: string; slug?: string; isActive?: boolean; countryId?: string };
type Match = 'exact' | 'prefix' | 'contains' | 'first';
const norm = (s: string) => s.trim().toLowerCase();

function pickByName<T extends Ref>(list: T[], q: string): { item: T; match: Match } | null {
  const n = norm(q);
  const name = (x: T) => norm(x.nameEn ?? '');
  const exact = list.find((x) => name(x) === n || (x.slug && x.slug === slugify(q)));
  if (exact) return { item: exact, match: 'exact' };
  const prefix = list.find((x) => name(x).startsWith(n));
  if (prefix) return { item: prefix, match: 'prefix' };
  const contains = list.find((x) => name(x).includes(n) || (name(x).length > 3 && n.includes(name(x))));
  if (contains) return { item: contains, match: 'contains' };
  return list[0] ? { item: list[0], match: 'first' } : null;
}

async function refSearch(path: string, params: Params): Promise<Ref[]> {
  const r = await apiGet<{ data?: Ref[] }>(path, { limit: 25, ...params });
  return r.data ?? [];
}

async function resolveCity(countryId: string, input: string): Promise<{ city: Ref | null; match: Match | null; suggestions: string[] }> {
  const q = input.trim();
  let picked = pickByName(await refSearch('/references/cities', { countryId, search: q }), q);
  if (!picked) {
    const first = q.split(/[\s,-]+/).filter((w) => w.length > 2)[0];
    if (first && norm(first) !== norm(q)) picked = pickByName(await refSearch('/references/cities', { countryId, search: first }), q);
  }
  if (picked) return { city: picked.item, match: picked.match, suggestions: [] };
  const sample = await refSearch('/references/cities', { countryId, limit: 15 });
  return { city: null, match: null, suggestions: sample.map((c) => c.nameEn ?? '').filter(Boolean) };
}

async function resolveSpecialization(text: string): Promise<{ specialization: Ref; match: Match; query: string } | null> {
  const tries = [text.trim()];
  const role = extractTerms(text, ROLE_DICT)[0]?.term;
  if (role && !tries.includes(role)) tries.push(role);
  for (const w of roleTokens(text)) if (w.length > 3 && !tries.includes(w)) tries.push(w);
  for (const q of tries.slice(0, 5)) {
    const list = (await refSearch('/references/specializations', { search: q })).filter((s) => s.isActive !== false);
    const p = pickByName(list, text);
    if (p) return { specialization: p.item, match: p.match, query: q };
  }
  return null;
}

type ResolvedSkill = { input: string; id: string; name: string };
async function resolveSkillIds(names: string[]): Promise<{ resolved: ResolvedSkill[]; unresolved: string[] }> {
  const out = await Promise.all(
    names.slice(0, 15).map(async (input): Promise<ResolvedSkill | string> => {
      const list = await refSearch('/references/skills', { search: input, limit: 10 });
      const p = pickByName(list, input);
      if (p && (p.match !== 'first' || list.length === 1)) return { input, id: p.item.id, name: p.item.nameEn ?? input };
      return input;
    }),
  );
  return {
    resolved: out.filter((x): x is ResolvedSkill => typeof x !== 'string'),
    unresolved: out.filter((x): x is string => typeof x === 'string'),
  };
}

// ---------- own jobs ----------
const manageUrl = (id: string) => `${SITE}/employer/jobs/${id}`;
const publicJobUrl = (j: ApiJob) => `${SITE}/${ccOf(j)}/vacancies/${j.id}`;
const jobSkillNames = (j: ApiJob) => (j.skills ?? []).map((s) => s.nameEn ?? s.name ?? s.skill?.nameEn ?? '').filter(Boolean);

function compactOwnJob(j: ApiJob) {
  const expired = !!j.expiresAt && Date.parse(j.expiresAt) < Date.now();
  return {
    id: j.id,
    title: j.title,
    status: j.isActive === false ? 'closed' : expired ? 'expired' : 'active',
    location: [j.city?.nameEn, j.country?.nameEn ?? countryById.get(j.countryId ?? '')?.name].filter(Boolean).join(', ') || null,
    work_location: j.workLocation === 'office' ? 'onsite' : (j.workLocation ?? null),
    employment_type: j.employmentType ?? null,
    experience: j.experienceLevel ?? null,
    salary: fmtSalary(j),
    specialization: j.specialization?.nameEn ?? null,
    applications: j._count?.applications ?? null,
    published_at: j.publishedAt ?? null,
    expires_at: j.expiresAt ?? null,
    url: publicJobUrl(j),
    manage_url: manageUrl(j.id),
  };
}

/** Public GET /jobs/:id first (no key); closed jobs may be hidden there, so fall back to scanning /my-jobs. */
async function getOwnJob(id: string): Promise<ApiJob> {
  await loadCountries();
  try {
    const r = await apiGet<{ data?: ApiJob }>(`/jobs/${encodeURIComponent(id)}`);
    const j = (r.data ?? (r as unknown)) as ApiJob;
    if (j?.id) return j;
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 400)) throw e;
  }
  for (let page = 1; page <= 5; page++) {
    const r = await apiFetch<JobList>('/my-jobs', { auth: true, params: { page, limit: 100 } });
    const data = r.data ?? [];
    const hit = data.find((j) => j.id === id);
    if (hit) return hit;
    if (data.length < 100) break;
  }
  throw new ApiError(404, `Job ${id} not found (neither public nor among this company's jobs)`, 'NOT_FOUND', "Use my_jobs to list this company's job ids.");
}

function foreignJobError(j: ApiJob, company: MeCompany): ToolResult | null {
  const owner = j.companyId ?? j.company?.id ?? null;
  if (owner && owner !== company.id) {
    return fail(`Job ${j.id} belongs to "${j.company?.name ?? owner}", not to ${company.name ?? company.id}.`, { code: 'FORBIDDEN' });
  }
  return null;
}

const expiresAtFromDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const toApiWorkLocation = (w: 'remote' | 'onsite' | 'hybrid') => (w === 'onsite' ? 'office' : w);

// ---------- candidates (resumes) ----------
type ApiResume = {
  id: string;
  title?: string | null;
  bio?: string | null;
  experienceLevel?: string | null;
  desiredSalaryMin?: number | null;
  desiredSalaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  countryId?: string | null;
  cityId?: string | null;
  country?: { id?: string; nameEn?: string; code?: string } | null;
  city?: { id?: string; nameEn?: string } | null;
  employmentType?: string | null;
  workLocation?: string | null;
  isReadyToRelocate?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  linkedinUrl?: string | null;
  portfolioUrl?: string | null;
  publishedAt?: string | null;
  completionPercentage?: number | null;
  hasFullAccess?: boolean | null;
  skills?: Array<{ id?: string; nameEn?: string; name?: string; skill?: { id?: string; nameEn?: string } | null }> | null;
  specialization?: { id?: string; nameEn?: string; slug?: string } | null;
  user?: { id?: string; email?: string | null; profile?: { firstName?: string; lastName?: string; avatarUrl?: string | null } | null } | null;
  experience?: Array<{ title?: string; company?: string; startDate?: string; endDate?: string; isCurrent?: boolean; description?: string }> | null;
  resumeLanguages?: Array<{ language?: { name?: string; code?: string } | null; level?: string }> | null;
  educations?: Array<{ degree?: string; institution?: string; field?: string }> | null;
};
type ResumeList = { data?: ApiResume[]; total?: number; page?: number; limit?: number };

const resumeSkillNames = (r: ApiResume) => (r.skills ?? []).map((s) => s.nameEn ?? s.name ?? s.skill?.nameEn ?? '').filter(Boolean);
const currentRole = (r: ApiResume) => (r.experience ?? []).find((e) => e.isCurrent) ?? r.experience?.[0] ?? null;
const resumeCountry = (r: ApiResume): Country | null =>
  countryById.get(r.country?.id ?? r.countryId ?? '') ??
  (r.country?.nameEn ? { id: r.country.id ?? '', code: r.country.code ?? '', slug: '', name: r.country.nameEn } : null);
const CONTACT_NOTE = 'Contact details appear only when ENTRA returns them (hasFullAccess: the candidate applied to one of your jobs or accepted your invitation). Nothing is inferred.';

function compactCandidate(r: ApiResume) {
  const country = resumeCountry(r);
  const full = r.hasFullAccess === true;
  const contact: Record<string, string> = {};
  if (full) {
    const pairs: Array<[string, string | null | undefined]> = [
      ['email', r.user?.email],
      ['phone', r.phone],
      ['whatsapp', r.whatsapp],
      ['linkedin', r.linkedinUrl],
      ['portfolio', r.portfolioUrl],
    ];
    for (const [k, v] of pairs) if (v) contact[k] = v;
  }
  const name = [r.user?.profile?.firstName, r.user?.profile?.lastName].filter(Boolean).join(' ') || null;
  const cur = currentRole(r);
  const expected = fmtSalary({ id: r.id, title: '', salaryMin: r.desiredSalaryMin, salaryMax: r.desiredSalaryMax, salaryCurrency: r.salaryCurrency, salaryPeriod: r.salaryPeriod });
  return {
    id: r.id,
    name,
    title: r.title ?? null,
    experience_level: r.experienceLevel ?? null,
    specialization: r.specialization?.nameEn ?? null,
    location: [r.city?.nameEn, country?.name].filter(Boolean).join(', ') || null,
    country_code: country?.code || null,
    ready_to_relocate: r.isReadyToRelocate ?? null,
    work_location: r.workLocation === 'office' ? 'onsite' : (r.workLocation ?? null),
    employment_type: r.employmentType ?? null,
    expected_salary: expected,
    skills: resumeSkillNames(r).slice(0, 15),
    languages: (r.resumeLanguages ?? []).map((l) => [l.language?.name, l.level].filter(Boolean).join(' · ')).filter(Boolean),
    current_role: cur ? [cur.title, cur.company].filter(Boolean).join(' @ ') || null : null,
    education: (r.educations ?? []).slice(0, 2).map((e) => [e.degree, e.field, e.institution].filter(Boolean).join(', ')).filter(Boolean),
    bio: (r.bio ?? '').slice(0, 300) || null,
    published_at: r.publishedAt ?? null,
    profile_completion: r.completionPercentage ?? null,
    contact_access: full,
    contact: full && Object.keys(contact).length ? contact : null,
    url: `${SITE}/${(country?.code || 'us').toLowerCase()}/candidates/${r.id}`,
  };
}

// ---------- candidate scoring (explainable, 0–100) ----------
type JobProfile = {
  skills: string[];
  role: string | null;
  seniority: ExpLevel | null;
  remote: boolean;
  country: Country | null;
  salary: string | null;
};
type ScoredCandidate = { resume: ApiResume; score: number; why: string[]; matched: string[]; gaps: string[] };

function scoreCandidate(r: ApiResume, p: JobProfile): ScoredCandidate {
  const why: string[] = [];
  let earned = 0;
  let possible = 0;
  const title = r.title ?? '';
  const cur = currentRole(r);
  const text = [
    title,
    r.bio ?? '',
    resumeSkillNames(r).join(' '),
    r.specialization?.nameEn ?? '',
    ...(r.experience ?? []).map((e) => `${e.title ?? ''} ${e.description ?? ''}`),
    ...(r.educations ?? []).map((e) => `${e.degree ?? ''} ${e.field ?? ''}`),
  ]
    .join('\n')
    .toLowerCase();

  const matched: string[] = [];
  const inTitle: string[] = [];
  const gaps: string[] = [];
  const skills = p.skills.slice(0, 12);
  if (skills.length) {
    possible += 50;
    for (const s of skills) {
      const re = termRegex(s);
      if (re.test(text)) {
        matched.push(s);
        if (re.test(title.toLowerCase())) inTitle.push(s);
      } else gaps.push(s);
    }
    earned += Math.min(50, Math.round((50 * matched.length) / skills.length) + (inTitle.length ? 5 : 0));
    why.push(matched.length ? `Skills: ${matched.length}/${skills.length} of the job's skills found (${matched.join(', ')})` : `Skills: none of the job's ${skills.length} skills found in the profile`);
    if (inTitle.length) why.push(`In the candidate's headline: ${inTitle.join(', ')}`);
  }

  if (p.role) {
    possible += 25;
    const rt = roleTokens(p.role);
    const ct = new Set(roleTokens([title, r.specialization?.nameEn ?? '', cur?.title ?? ''].join(' ')));
    const hit = rt.filter((t) => ct.has(t));
    const frac = rt.length ? hit.length / rt.length : 0;
    let pts = Math.round(25 * frac);
    if (!pts && termRegex(p.role).test(text)) pts = 5;
    earned += pts;
    why.push(
      frac >= 0.99
        ? `Title match: "${title}" fits "${p.role}"`
        : frac > 0
          ? `Partial title match (${Math.round(frac * 100)}%): "${title}" vs "${p.role}"`
          : pts
            ? `Role "${p.role}" appears in the profile text, not the headline`
            : `Headline "${title}" does not match "${p.role}"`,
    );
  }

  if (p.seniority) {
    possible += 10;
    if (isExpLevel(r.experienceLevel)) {
      const d = Math.abs(EXP_ORDER.indexOf(r.experienceLevel) - EXP_ORDER.indexOf(p.seniority));
      earned += d === 0 ? 10 : d === 1 ? 5 : 0;
      why.push(`Seniority: job asks ${EXP_LABEL[p.seniority]}, candidate has ${EXP_LABEL[r.experienceLevel]} — ${d === 0 ? 'match' : d === 1 ? 'close' : 'mismatch'}`);
    } else {
      earned += 5;
      why.push('Seniority: not stated on the profile');
    }
  }

  possible += 10;
  const cc = resumeCountry(r);
  if (p.remote) {
    const pref = r.workLocation ?? null;
    earned += pref === 'office' ? 5 : 10;
    why.push(pref === 'office' ? 'Remote role, but the candidate prefers office work' : `Remote role — candidate location ${cc?.name ?? 'unknown'} is not a blocker`);
  } else if (p.country) {
    if (cc?.id === p.country.id) {
      earned += 10;
      why.push(`Located in ${p.country.name} (job country)`);
    } else if (r.isReadyToRelocate === 'ready' || r.isReadyToRelocate === 'considering') {
      earned += r.isReadyToRelocate === 'ready' ? 7 : 5;
      why.push(`Located in ${cc?.name ?? 'unknown country'}, ${r.isReadyToRelocate === 'ready' ? 'ready' : 'considering'} to relocate to ${p.country.name}`);
    } else {
      why.push(`Located in ${cc?.name ?? 'unknown country'}, job is ${p.country.name} — relocation not indicated`);
    }
  } else {
    earned += 5;
    why.push('Location: job country unknown');
  }

  const expected = fmtSalary({ id: r.id, title: '', salaryMin: r.desiredSalaryMin, salaryMax: r.desiredSalaryMax, salaryCurrency: r.salaryCurrency, salaryPeriod: r.salaryPeriod });
  if (expected) why.push(`Expected salary: ${expected}${p.salary ? ` (job band ${p.salary})` : ''} — informational, not scored`);

  const score = possible ? Math.round((100 * earned) / possible) : 0;
  return { resume: r, score, why, matched, gaps: gaps.slice(0, 5) };
}
const CANDIDATE_FIT_NOTE =
  'fit_score is deterministic keyword matching (skills overlap, headline vs role, seniority, location/remote) — not a prediction. Review profiles before contacting; contact details are shown only when ENTRA grants access.';

// ---------- employer tool schemas ----------
const employmentEnum = z.enum(['full_time', 'part_time', 'contract', 'freelance', 'internship']);
const workLocationEnum = z.enum(['remote', 'onsite', 'hybrid']);
const salaryPeriodEnum = z.enum(['hourly', 'daily', 'weekly', 'monthly', 'yearly']);
const applicationStatusEnum = z.enum(['pending', 'invitation', 'interview', 'offer', 'rejected', 'withdrawn']);

const postJobShape = {
  title: z.string().min(3).max(200).describe('Job title (3–200 chars)'),
  description: z.string().min(10).max(10000).describe('Job description, plain text or markdown (10–10000 chars)'),
  requirements: z.string().max(5000).optional().describe('Requirements (≤5000 chars)'),
  employment_type: employmentEnum.describe('full_time | part_time | contract | freelance | internship'),
  work_location: workLocationEnum.describe('remote | onsite | hybrid'),
  country: z.string().describe('ISO-2 code (US, GB, AE…) or country name'),
  city: z.string().describe('City name — required by ENTRA even for remote roles (use the company HQ city). Resolved via /references/cities.'),
  specialization: z.string().optional().describe('Specialization, free text (e.g. "Sales Manager"). Defaults to the title; best active match is used and reported.'),
  experience_level: experienceEnum.optional().describe('Defaults to the level detected from the title/text, else 1_3_years'),
  salary_min: z.number().int().min(0).optional(),
  salary_max: z.number().int().min(0).optional(),
  salary_currency: z.string().length(3).optional().describe('ISO-4217, default USD'),
  salary_period: salaryPeriodEnum.optional().describe('hourly | daily | weekly | monthly | yearly — ENTRA default is monthly; pass "yearly" for annual figures'),
  benefits: z.array(z.string().max(100)).max(20).optional(),
  skills: z.array(z.string()).max(15).optional().describe('Skill names; resolved to ENTRA skills where an unambiguous match exists'),
  internal_job_id: z.string().max(100).regex(/^[a-zA-Z0-9_/-]*$/).optional().describe('Your ATS reference, e.g. "ENG-123"'),
  expires_in_days: z.number().int().min(1).max(365).optional().describe('Listing lifetime (default 30)'),
};
type PostJobArgs = z.infer<z.ZodObject<typeof postJobShape>>;

const updateJobShape = {
  job_id: z.string().describe('Job id (from my_jobs / post_job)'),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(10).max(10000).optional(),
  requirements: z.string().max(5000).optional(),
  employment_type: employmentEnum.optional(),
  work_location: workLocationEnum.optional(),
  experience_level: experienceEnum.optional(),
  country: z.string().optional().describe('Change location — pass country AND city together'),
  city: z.string().optional(),
  specialization: z.string().optional().describe('Free text, resolved to the best active specialization'),
  salary_min: z.number().int().min(0).optional(),
  salary_max: z.number().int().min(0).optional(),
  salary_currency: z.string().length(3).optional(),
  salary_period: salaryPeriodEnum.optional(),
  benefits: z.array(z.string().max(100)).max(20).optional(),
  internal_job_id: z.string().max(100).regex(/^[a-zA-Z0-9_/-]*$/).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional().describe('Extend: new expiry = now + N days'),
  is_active: z.boolean().optional().describe('true re-opens a closed job; false closes it (same as close_job)'),
};
type UpdateJobArgs = z.infer<z.ZodObject<typeof updateJobShape>>;

const searchCandidatesShape = {
  query: z.string().optional().describe('Free text matched against resume title/bio, e.g. "sales manager"'),
  skills: z.array(z.string()).max(10).optional().describe('Skill names (ANY match); resolved to ENTRA skill ids'),
  specialization: z.string().optional().describe('Specialization, free text'),
  country: z.string().optional().describe('ISO-2 code or country name'),
  city: z.string().optional().describe('City name (needs country)'),
  experience: experienceEnum.optional(),
  work_location: workLocationEnum.optional().describe('Candidate preference: remote | onsite | hybrid'),
  remote_only: z.boolean().optional().describe('Shorthand for work_location="remote"'),
  employment_type: employmentEnum.optional(),
  ready_to_relocate: z.enum(['ready', 'not_ready', 'considering']).optional(),
  salary_min: z.number().int().min(0).optional().describe('Expected-salary filter passed through to ENTRA (salaryMin)'),
  salary_max: z.number().int().min(0).optional().describe('Expected-salary filter passed through to ENTRA (salaryMax)'),
  salary_currency: z.string().length(3).optional(),
  has_linkedin: z.boolean().optional(),
  has_portfolio: z.boolean().optional(),
  published_within_days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(25).optional().describe('Max candidates (default 10, max 25)'),
  page: z.number().int().min(1).optional(),
};
type SearchCandidatesArgs = z.infer<z.ZodObject<typeof searchCandidatesShape>>;

const matchCandidatesShape = {
  job_id: z.string().optional().describe('One of your job ids (from my_jobs / post_job)'),
  job_text: z.string().max(12000).optional().describe('Alternative to job_id: job title on the first line, then the description'),
  country: z.string().optional().describe('Country filter for job_text input (ISO-2 or name); ignored when job_id is given'),
  include_other_countries: z.boolean().optional().describe('For onsite/hybrid jobs, also consider candidates outside the job country (default false)'),
  limit: z.number().int().min(1).max(20).optional().describe('Top N (default 10, max 20)'),
};
type MatchCandidatesArgs = z.infer<z.ZodObject<typeof matchCandidatesShape>>;

// ---------- employer tool implementations ----------
async function runWhoami(): Promise<ToolResult> {
  const me = await whoami();
  const scopes = me.apiKey?.scopes ?? [];
  const tools: Record<string, Scope> = {
    my_jobs: 'jobs:read',
    post_job: 'jobs:write',
    update_job: 'jobs:write',
    close_job: 'jobs:write',
    job_applications: 'applications:read',
    search_candidates: 'candidates:read',
    match_candidates: 'candidates:read',
  };
  return ok({
    mode: 'employer',
    auth_method: me.authMethod ?? 'api_key',
    company: me.company ? { id: me.company.id, name: me.company.name ?? null, slug: me.company.slug ?? null, url: companyUrl(me.company.slug) } : null,
    user: me.user ? { name: [me.user.firstName, me.user.lastName].filter(Boolean).join(' ') || null, email: me.user.email ?? null, role: me.user.role ?? null } : null,
    api_key: me.apiKey ? { name: me.apiKey.name ?? null, prefix: me.apiKey.keyPrefix ?? null, scopes } : null,
    tools_available: Object.entries(tools).filter(([, s]) => scopes.includes(s)).map(([t]) => t).concat('employer_whoami'),
    tools_missing_scope: Object.entries(tools).filter(([, s]) => !scopes.includes(s)).map(([t, s]) => `${t} (needs ${s})`),
    manage_keys_url: API_KEYS_URL,
  });
}

async function runPostJob(a: PostJobArgs): Promise<ToolResult> {
  const ctx = await employerContext('jobs:write');
  if (isCtxError(ctx)) return ctx.error;
  const notes: string[] = [];

  const country = await resolveCountry(a.country);
  if (!country) return fail(await unknownCountryMessage(a.country));
  const cityRes = await resolveCity(country.id, a.city);
  if (!cityRes.city) {
    return fail(`City "${a.city}" not found in ${country.name}. ENTRA requires a city id.`, {
      code: 'CITY_NOT_FOUND',
      suggestions: cityRes.suggestions,
      hint: 'Retry with one of the suggested city names.',
    });
  }
  if (cityRes.match !== 'exact') notes.push(`city "${a.city}" resolved to "${cityRes.city.nameEn}" (${cityRes.match} match)`);

  const specText = a.specialization?.trim() || a.title;
  const spec = await resolveSpecialization(specText);
  if (!spec) {
    return fail(`No active ENTRA specialization matches "${specText}".`, {
      code: 'SPECIALIZATION_NOT_FOUND',
      hint: 'Pass specialization as a broader term, e.g. "Sales Manager", "Software Engineer", "Data Scientist".',
    });
  }
  if (spec.match !== 'exact' || !a.specialization) notes.push(`specialization "${specText}" resolved to "${spec.specialization.nameEn}" (${spec.match} match via "${spec.query}")`);

  const detected = a.experience_level ? null : detectSeniority(`${a.title}\n${a.requirements ?? ''}\n${a.description}`);
  const experienceLevel: ExpLevel = a.experience_level ?? detected?.level ?? '1_3_years';
  if (!a.experience_level) notes.push(detected ? `experience_level detected as ${experienceLevel} (${detected.basis})` : 'experience_level not given and not detectable — defaulted to 1_3_years');

  if (a.salary_min !== undefined && a.salary_max !== undefined && a.salary_min > a.salary_max) return fail('salary_min must be ≤ salary_max');
  const hasSal = a.salary_min !== undefined || a.salary_max !== undefined;
  const salaryPeriod = hasSal ? (a.salary_period ?? 'monthly') : undefined;
  if (hasSal && !a.salary_period) notes.push('salary_period not given — defaulted to monthly (ENTRA default); pass salary_period:"yearly" for annual figures');

  const skillRes = a.skills?.length ? await resolveSkillIds(a.skills) : { resolved: [], unresolved: [] };
  if (skillRes.unresolved.length) notes.push(`skills not found on ENTRA (omitted): ${skillRes.unresolved.join(', ')}`);

  const days = a.expires_in_days ?? 30;
  const body: Json = {
    title: a.title,
    description: a.description,
    companyId: ctx.company.id,
    employmentType: a.employment_type,
    workLocation: toApiWorkLocation(a.work_location),
    experienceLevel,
    countryId: country.id,
    cityId: cityRes.city.id,
    specializationId: spec.specialization.id,
    expiresAt: expiresAtFromDays(days),
    ...(a.requirements ? { requirements: a.requirements } : {}),
    ...(a.salary_min !== undefined ? { salaryMin: a.salary_min } : {}),
    ...(a.salary_max !== undefined ? { salaryMax: a.salary_max } : {}),
    ...(hasSal ? { salaryCurrency: (a.salary_currency ?? 'USD').toUpperCase(), salaryPeriod } : {}),
    ...(a.benefits?.length ? { benefits: a.benefits } : {}),
    ...(a.internal_job_id ? { internalJobId: a.internal_job_id } : {}),
    ...(skillRes.resolved.length ? { skills: skillRes.resolved.map((s) => ({ skillId: s.id, isRequired: true })) } : {}),
  };

  let job: ApiJob;
  try {
    const r = await apiFetch<{ data?: ApiJob }>('/jobs', { method: 'POST', body, auth: true });
    job = (r.data ?? (r as unknown)) as ApiJob;
  } catch (e) {
    if (isSubscription403(e)) return needsSubscription('jobs', e as ApiError);
    throw e;
  }
  if (!job.country && !job.countryId) job.countryId = country.id; // for the URL if the API omits the relation
  return ok({
    posted: true,
    job: compactOwnJob(job),
    resolved: {
      country: `${country.name} (${country.code})`,
      city: cityRes.city.nameEn ?? null,
      specialization: spec.specialization.nameEn ?? null,
      experience_level: experienceLevel,
      salary_period: salaryPeriod ?? null,
      skills: skillRes.resolved.map((s) => s.name),
      expires_at: body.expiresAt,
    },
    ...(notes.length ? { notes } : {}),
    next: 'Share job.url with candidates; use my_jobs / job_applications to track applicants.',
  });
}

async function runMyJobs(a: { status?: 'active' | 'closed' | 'all'; search?: string; limit?: number; page?: number }): Promise<ToolResult> {
  const ctx = await employerContext('jobs:read');
  if (isCtxError(ctx)) return ctx.error;
  await loadCountries();
  const status = a.status ?? 'active';
  const r = await apiFetch<JobList>('/my-jobs', {
    auth: true,
    params: {
      isActive: status === 'all' ? undefined : status === 'active',
      search: a.search,
      limit: a.limit ?? 20,
      page: a.page ?? 1,
      sortBy: 'publishedAt',
      sortOrder: 'desc',
    },
  });
  const jobs = (r.data ?? []).map(compactOwnJob);
  return ok({
    company: ctx.company.name ?? ctx.company.id,
    status,
    total: r.total ?? jobs.length,
    page: r.page ?? a.page ?? 1,
    returned: jobs.length,
    jobs,
  });
}

async function runCloseJob(a: { job_id: string; confirm?: boolean }): Promise<ToolResult> {
  const ctx = await employerContext('jobs:write');
  if (isCtxError(ctx)) return ctx.error;
  const job = await getOwnJob(a.job_id);
  const foreign = foreignJobError(job, ctx.company);
  if (foreign) return foreign;
  if (!a.confirm) {
    return ok({
      preview: true,
      action: 'close (unpublish) this job — reversible with update_job {is_active: true}',
      job: compactOwnJob(job),
      applications: job._count?.applications ?? null,
      confirm_with: { job_id: a.job_id, confirm: true },
    });
  }
  const r = await apiFetch<{ data?: ApiJob }>(`/jobs/${encodeURIComponent(a.job_id)}`, { method: 'PATCH', body: { isActive: false }, auth: true });
  const updated = (r.data ?? (r as unknown)) as ApiJob;
  return ok({ closed: true, job: compactOwnJob({ ...job, ...updated, isActive: false }) });
}

async function runUpdateJob(a: UpdateJobArgs): Promise<ToolResult> {
  const ctx = await employerContext('jobs:write');
  if (isCtxError(ctx)) return ctx.error;
  const notes: string[] = [];
  const body: Json = {};
  if (a.title !== undefined) body.title = a.title;
  if (a.description !== undefined) body.description = a.description;
  if (a.requirements !== undefined) body.requirements = a.requirements;
  if (a.employment_type) body.employmentType = a.employment_type;
  if (a.work_location) body.workLocation = toApiWorkLocation(a.work_location);
  if (a.experience_level) body.experienceLevel = a.experience_level;
  if (a.salary_min !== undefined) body.salaryMin = a.salary_min;
  if (a.salary_max !== undefined) body.salaryMax = a.salary_max;
  if (a.salary_min !== undefined && a.salary_max !== undefined && a.salary_min > a.salary_max) return fail('salary_min must be ≤ salary_max');
  if (a.salary_currency) body.salaryCurrency = a.salary_currency.toUpperCase();
  if (a.salary_period) body.salaryPeriod = a.salary_period;
  if (a.benefits) body.benefits = a.benefits;
  if (a.internal_job_id !== undefined) body.internalJobId = a.internal_job_id;
  if (a.expires_in_days) body.expiresAt = expiresAtFromDays(a.expires_in_days);
  if (a.is_active !== undefined) body.isActive = a.is_active;
  if (a.country || a.city) {
    if (!a.country || !a.city) return fail('To change the location pass both country and city.');
    const country = await resolveCountry(a.country);
    if (!country) return fail(await unknownCountryMessage(a.country));
    const cityRes = await resolveCity(country.id, a.city);
    if (!cityRes.city) return fail(`City "${a.city}" not found in ${country.name}.`, { code: 'CITY_NOT_FOUND', suggestions: cityRes.suggestions });
    if (cityRes.match !== 'exact') notes.push(`city "${a.city}" resolved to "${cityRes.city.nameEn}" (${cityRes.match} match)`);
    body.countryId = country.id;
    body.cityId = cityRes.city.id;
  }
  if (a.specialization) {
    const spec = await resolveSpecialization(a.specialization);
    if (!spec) return fail(`No active ENTRA specialization matches "${a.specialization}".`, { code: 'SPECIALIZATION_NOT_FOUND' });
    if (spec.match !== 'exact') notes.push(`specialization resolved to "${spec.specialization.nameEn}" (${spec.match} match)`);
    body.specializationId = spec.specialization.id;
  }
  if (!Object.keys(body).length) return fail('Nothing to update — pass at least one field besides job_id.');

  const job = await getOwnJob(a.job_id);
  const foreign = foreignJobError(job, ctx.company);
  if (foreign) return foreign;
  const r = await apiFetch<{ data?: ApiJob }>(`/jobs/${encodeURIComponent(a.job_id)}`, { method: 'PATCH', body, auth: true });
  const updated = (r.data ?? (r as unknown)) as ApiJob;
  return ok({
    updated: true,
    fields: Object.keys(body),
    job: compactOwnJob({ ...job, ...updated }),
    ...(notes.length ? { notes } : {}),
  });
}

type ApiApplication = {
  id: string;
  jobId?: string;
  status?: string;
  coverLetter?: string | null;
  appliedAt?: string;
  isUnread?: boolean;
  user?: { id?: string; firstName?: string; lastName?: string; email?: string; phone?: string; avatarUrl?: string } | null;
  job?: { id?: string; title?: string; company?: { name?: string } | null; country?: { id?: string; nameEn?: string } | null } | null;
  resume?: { id?: string; title?: string; phone?: string | null; whatsapp?: string | null; linkedinUrl?: string | null; portfolioUrl?: string | null; bio?: string | null } | null;
};
type ApplicationList = { success?: boolean; data?: ApiApplication[]; total?: number; page?: number; limit?: number };

function compactApplication(app: ApiApplication) {
  const contact: Record<string, string> = {};
  const pairs: Array<[string, string | null | undefined]> = [
    ['email', app.user?.email],
    ['phone', app.user?.phone ?? app.resume?.phone],
    ['whatsapp', app.resume?.whatsapp],
    ['linkedin', app.resume?.linkedinUrl],
    ['portfolio', app.resume?.portfolioUrl],
  ];
  for (const [k, v] of pairs) if (v) contact[k] = v;
  const cc = (codeById.get(app.job?.country?.id ?? '') ?? 'us').toLowerCase();
  return {
    id: app.id,
    status: app.status ?? null,
    applied_at: app.appliedAt ?? null,
    unread: app.isUnread ?? null,
    job: app.job ? { id: app.job.id ?? app.jobId ?? null, title: app.job.title ?? null } : { id: app.jobId ?? null, title: null },
    candidate: [app.user?.firstName, app.user?.lastName].filter(Boolean).join(' ') || null,
    resume: app.resume ? { id: app.resume.id ?? null, title: app.resume.title ?? null, bio: (app.resume.bio ?? '').slice(0, 300) || null, url: app.resume.id ? `${SITE}/${cc}/candidates/${app.resume.id}` : null } : null,
    contact: Object.keys(contact).length ? contact : null,
    cover_letter: (app.coverLetter ?? '').slice(0, 600) || null,
  };
}

async function runJobApplications(a: { job_id?: string; status?: z.infer<typeof applicationStatusEnum>; limit?: number; page?: number }): Promise<ToolResult> {
  const ctx = await employerContext('applications:read');
  if (isCtxError(ctx)) return ctx.error;
  await loadCountries();
  const path = a.job_id ? `/jobs/${encodeURIComponent(a.job_id)}/applications` : '/employer/applications';
  const r = await apiFetch<ApplicationList>(path, { auth: true, params: { page: a.page ?? 1, limit: a.limit ?? 20 } });
  let apps = r.data ?? [];
  if (a.status) apps = apps.filter((x) => x.status === a.status);
  const counts: Record<string, number> = {};
  for (const x of r.data ?? []) counts[x.status ?? 'unknown'] = (counts[x.status ?? 'unknown'] ?? 0) + 1;
  return ok({
    scope: a.job_id ? { job_id: a.job_id } : { company: ctx.company.name ?? ctx.company.id },
    total: r.total ?? apps.length,
    page: r.page ?? a.page ?? 1,
    returned: apps.length,
    status_counts_on_page: counts,
    ...(a.status ? { status_filter: `${a.status} (applied client-side to this page)` } : {}),
    applications: apps.map(compactApplication),
    note: `${CONTACT_NOTE} Status changes are not available via API keys — use ${SITE}/employer/applications.`,
  });
}

async function runSearchCandidates(a: SearchCandidatesArgs): Promise<ToolResult> {
  const ctx = await employerContext('candidates:read');
  if (isCtxError(ctx)) return ctx.error;
  await loadCountries();
  const notes: string[] = [];
  const params: Params = {
    search: a.query?.trim() || undefined,
    experienceLevel: a.experience,
    employmentType: a.employment_type,
    isReadyToRelocate: a.ready_to_relocate,
    salaryMin: a.salary_min,
    salaryMax: a.salary_max,
    salaryCurrency: a.salary_currency?.toUpperCase(),
    hasLinkedIn: a.has_linkedin,
    hasPortfolio: a.has_portfolio,
    limit: a.limit ?? 10,
    page: a.page ?? 1,
  };
  const wl = a.work_location ?? (a.remote_only ? 'remote' : undefined);
  if (wl) params.workLocation = toApiWorkLocation(wl);
  if (a.published_within_days) params.publishedDateFrom = new Date(Date.now() - a.published_within_days * 86_400_000).toISOString().slice(0, 10);

  const resolved: Json = {};
  if (a.country) {
    const country = await resolveCountry(a.country);
    if (!country) return fail(await unknownCountryMessage(a.country));
    params.countryId = country.id;
    resolved.country = `${country.name} (${country.code})`;
    if (a.city) {
      const cityRes = await resolveCity(country.id, a.city);
      if (!cityRes.city) return fail(`City "${a.city}" not found in ${country.name}.`, { code: 'CITY_NOT_FOUND', suggestions: cityRes.suggestions });
      params.cityId = cityRes.city.id;
      resolved.city = cityRes.city.nameEn ?? null;
    }
  } else if (a.city) return fail('city needs a country.');
  if (a.specialization) {
    const spec = await resolveSpecialization(a.specialization);
    if (!spec) return fail(`No active ENTRA specialization matches "${a.specialization}".`, { code: 'SPECIALIZATION_NOT_FOUND' });
    params.specializationId = spec.specialization.id;
    resolved.specialization = spec.specialization.nameEn ?? null;
    if (spec.match !== 'exact') notes.push(`specialization resolved to "${spec.specialization.nameEn}" (${spec.match} match)`);
  }
  if (a.skills?.length) {
    const s = await resolveSkillIds(a.skills);
    if (s.resolved.length) params.skills = s.resolved.map((x) => x.id);
    resolved.skills = s.resolved.map((x) => x.name);
    if (s.unresolved.length) notes.push(`skills not found on ENTRA (ignored): ${s.unresolved.join(', ')}`);
    if (!s.resolved.length) notes.push('none of the skills resolved — skill filter not applied');
  }
  if (!params.search && !params.skills && !params.specializationId && !params.countryId && !params.experienceLevel && !params.workLocation) {
    return fail('Give at least one of: query, skills, specialization, country, experience, work_location.');
  }

  let r: ResumeList;
  try {
    r = await apiFetch<ResumeList>('/resumes', { auth: true, params });
  } catch (e) {
    if (isSubscription403(e)) return needsSubscription('candidates', e as ApiError);
    throw e;
  }
  const candidates = (r.data ?? []).map(compactCandidate);
  return ok({
    total: r.total ?? candidates.length,
    page: r.page ?? a.page ?? 1,
    returned: candidates.length,
    filters_resolved: resolved,
    ...(notes.length ? { notes } : {}),
    candidates,
    note: CONTACT_NOTE,
  });
}

async function runMatchCandidates(a: MatchCandidatesArgs): Promise<ToolResult> {
  const ctx = await employerContext('candidates:read');
  if (isCtxError(ctx)) return ctx.error;
  await loadCountries();
  let job: ApiJob | null = null;
  let title: string;
  let text: string;
  if (a.job_id) {
    job = await getOwnJob(a.job_id);
    title = job.title ?? '';
    text = [title, job.requirements ?? '', job.description ?? ''].join('\n');
  } else if (a.job_text?.trim()) {
    const lines = a.job_text.trim().split('\n');
    title = lines[0].trim().slice(0, 200);
    text = a.job_text;
  } else return fail('Provide job_id (one of your jobs) or job_text (title on the first line, then the description).');

  const skills = [...new Set([...(job ? jobSkillNames(job).map(canonicalSkill) : []), ...extractTerms(text, SKILL_DICT).map((f) => f.term)])].slice(0, 12);
  const role = extractTerms(title, ROLE_DICT)[0]?.term ?? (roleTokens(title).join(' ') || title);
  const jobLevelRaw = job?.experienceLevel;
  const seniority: ExpLevel | null = isExpLevel(jobLevelRaw) ? jobLevelRaw : (detectSeniority(text)?.level ?? null);
  const remote = job ? job.workLocation === 'remote' : /\bremote\b/i.test(text);
  let country: Country | null = null;
  if (job) country = countryById.get(job.country?.id ?? job.countryId ?? '') ?? null;
  else if (a.country) {
    country = await resolveCountry(a.country);
    if (!country) return fail(await unknownCountryMessage(a.country));
  }
  if (!skills.length && !role) return fail('Could not derive skills or a role from the job. Add a clearer title or description.');

  const base: Params = !remote && country && !a.include_other_countries ? { countryId: country.id } : {};
  const queries: Array<{ label: string; params: Params }> = [];
  if (role) queries.push({ label: `search "${role}"`, params: { ...base, search: role } });
  const skillIds = skills.length ? await resolveSkillIds(skills.slice(0, 6)) : { resolved: [], unresolved: [] };
  if (skillIds.resolved.length) queries.push({ label: `skills any of [${skillIds.resolved.map((s) => s.name).join(', ')}]`, params: { ...base, skills: skillIds.resolved.map((s) => s.id) } });
  const extra = skills.find((s) => !(role && termRegex(s).test(role)));
  if (extra && queries.length < 3) queries.push({ label: `search "${extra}"`, params: { ...base, search: extra } });

  let results: ResumeList[];
  try {
    results = await Promise.all(queries.map((q) => apiFetch<ResumeList>('/resumes', { auth: true, params: { ...q.params, limit: 50 } })));
  } catch (e) {
    if (isSubscription403(e)) return needsSubscription('candidates', e as ApiError);
    throw e;
  }
  const seen = new Map<string, ApiResume>();
  for (const r of results) for (const c of r.data ?? []) if (!seen.has(c.id)) seen.set(c.id, c);

  const profile: JobProfile = { skills, role, seniority, remote, country, salary: job ? fmtSalary(job) : null };
  const ranked = [...seen.values()]
    .map((r) => scoreCandidate(r, profile))
    .sort((x, y) => y.score - x.score || Date.parse(y.resume.publishedAt ?? '') - Date.parse(x.resume.publishedAt ?? '') || 0)
    .slice(0, a.limit ?? 10);

  return ok({
    job: job ? compactOwnJob(job) : { title, source: 'job_text' },
    profile_used: {
      role,
      skills,
      seniority: seniority ? EXP_LABEL[seniority] : null,
      remote,
      country: country ? `${country.name} (${country.code})` : null,
      country_filter_applied: !!base.countryId,
    },
    queries_run: queries.map((q) => q.label),
    candidates_considered: seen.size,
    matches: ranked.map((s) => ({ ...compactCandidate(s.resume), fit_score: s.score, why: s.why, matched_skills: s.matched, skill_gaps: s.gaps })),
    note: CANDIDATE_FIT_NOTE,
  });
}

// ---------- MCP server ----------
const INSTRUCTIONS = [
  'ENTRA job platform. Candidate tools (search_jobs, match_jobs, salary_stats, companies_hiring, get_job, list_companies, prepare_application) are read-only and need no key.',
  EMPLOYER_MODE
    ? 'Employer mode is ON (ENTRA_API_KEY set): employer_whoami, post_job, my_jobs, update_job, close_job, job_applications, search_candidates, match_candidates act on the key\'s company. close_job needs confirm:true; post_job may return needs_subscription:true with a pricing_url.'
    : `Employer tools are not loaded — set ENTRA_API_KEY (create a key at ${API_KEYS_URL}) to post jobs and search candidates.`,
  'Matching is deterministic keyword scoring, never a prediction. Nothing is submitted to candidates on anyone\'s behalf.',
].join(' ');
const server = new McpServer({ name: 'entra', version: VERSION }, { instructions: INSTRUCTIONS });
const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

server.registerTool(
  'search_jobs',
  {
    title: 'Search ENTRA jobs',
    description:
      'Search thousands of verified AI & tech jobs on ENTRA (aggregated directly from company hiring systems — zero ghost jobs). Filters: work location, country, company, annual salary, experience, posted_within_days. rank_by date | salary | fit (fit needs profile_keywords). Returns total_found and live roles with salary bands and apply links.',
    inputSchema: searchShape,
    annotations: RO,
  },
  guarded(runSearchJobs),
);

server.registerTool(
  'get_job',
  {
    title: 'Get job details',
    description: 'Full details of one ENTRA job by id: description, requirements, skills, salary band, company, apply link.',
    inputSchema: { job_id: z.string().describe('Job id from search_jobs / match_jobs') },
    annotations: RO,
  },
  guarded(({ job_id }) => runGetJob(job_id)),
);

server.registerTool(
  'list_companies',
  {
    title: 'List companies on ENTRA',
    description: 'List companies hiring on ENTRA (OpenAI, Anthropic, SpaceX, Stripe and 300+ more) with open-role counts and profile links.',
    inputSchema: {
      query: z.string().optional().describe('Filter by company name'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
    },
    annotations: RO,
  },
  guarded(runListCompanies),
);

server.registerTool(
  'match_jobs',
  {
    title: 'Match a candidate to jobs',
    description:
      'AI matching, live: pass resume_text (free text) or skills[] plus optional target_role / remote_only / country / min_salary. Extracts skills, role and seniority deterministically, runs 2–4 searches, dedupes and ranks with an explainable fit_score (0–100), why[], matched_skills, skill_gaps, salary and a qualitative interview_chance_hint. ENTRA finds and ranks; the human applies.',
    inputSchema: matchShape,
    annotations: RO,
  },
  guarded(runMatchJobs),
);

server.registerTool(
  'match_profile',
  {
    title: 'Match profile (alias of match_jobs)',
    description: 'Backward-compatible alias of match_jobs: skills[] (+ role_hint, remote_only, limit) → ranked verified roles with fit explanation.',
    inputSchema: {
      skills: z.array(z.string()).min(1).describe('Key skills / technologies, e.g. ["python","llm","rag"]'),
      role_hint: z.string().optional().describe('Target role, e.g. "ML engineer"'),
      remote_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(15).optional(),
    },
    annotations: RO,
  },
  guarded(({ skills, role_hint, remote_only, limit }) =>
    runMatchJobs({ skills, target_role: role_hint, remote_only, limit: limit ?? 8 }),
  ),
);

server.registerTool(
  'salary_stats',
  {
    title: 'Salary stats for a role',
    description:
      'Salary statistics for a role query from ENTRA listings that publish a band (up to 150 most recent): count_with_salary, min / p25 / median / p75 / max per currency (annualized; USD reported as USD-equivalent, other currencies as-is), top 5 companies by count. Listed bands only — no estimates.',
    inputSchema: salaryShape,
    annotations: RO,
  },
  guarded(runSalaryStats),
);

server.registerTool(
  'companies_hiring',
  {
    title: 'Companies hiring for a role',
    description:
      'Which companies are hiring for a role right now: aggregates ENTRA search results (up to 300 most recent roles) into companies with open-role counts, sample titles, latest post date, verified flag and profile URLs.',
    inputSchema: hiringShape,
    annotations: RO,
  },
  guarded(runCompaniesHiring),
);

server.registerTool(
  'prepare_application',
  {
    title: 'Prepare a human-in-the-loop application',
    description: 'Prepare an application for an ENTRA job: returns the direct apply link and a short checklist. The human reviews and applies — no auto-submission.',
    inputSchema: { job_id: z.string().describe('Job id from search_jobs / match_jobs') },
    annotations: RO,
  },
  guarded(({ job_id }) => runPrepareApplication(job_id)),
);

// ---------- employer tools (registered only when ENTRA_API_KEY is set) ----------
if (EMPLOYER_MODE) {
  server.registerTool(
    'employer_whoami',
    {
      title: 'Employer: who am I',
      description:
        'Identify the employer API key: company, key name/prefix, granted scopes and which employer tools are usable. Calls GET /employer/api-keys/me (cached). Start here in employer mode.',
      inputSchema: {},
      annotations: RO,
    },
    guarded(() => runWhoami()),
  );

  server.registerTool(
    'post_job',
    {
      title: 'Employer: post a job',
      description:
        'Publish a job on ENTRA for your company (scope jobs:write). Human-friendly input: title, description, employment_type, work_location (remote/onsite/hybrid), country + city (names; resolved to ENTRA ids), optional specialization (free text, best active match), experience_level, salary band, benefits, skills, expires_in_days (default 30). Returns the public job URL, manage URL and every resolution made. If the company has no free vacancy slot, returns needs_subscription:true with pricing_url instead of an error.',
      inputSchema: postJobShape,
      annotations: WRITE,
    },
    guarded(runPostJob),
  );

  server.registerTool(
    'my_jobs',
    {
      title: 'Employer: my jobs',
      description: 'List your company\'s jobs (scope jobs:read): status active | closed | all, optional search, limit, page. Each job: status, location, salary, applications count, expiry, public + manage URLs.',
      inputSchema: {
        status: z.enum(['active', 'closed', 'all']).optional().describe('Default active'),
        search: z.string().optional().describe('Title/text filter'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
        page: z.number().int().min(1).optional(),
      },
      annotations: RO,
    },
    guarded(runMyJobs),
  );

  server.registerTool(
    'close_job',
    {
      title: 'Employer: close a job',
      description:
        'Close (unpublish) one of your jobs (scope jobs:write). Without confirm:true it only returns a preview of the job that would be closed; with confirm:true it PATCHes isActive:false. Reversible with update_job {is_active:true}.',
      inputSchema: {
        job_id: z.string().describe('Job id from my_jobs / post_job'),
        confirm: z.boolean().optional().describe('Must be true to actually close the job'),
      },
      annotations: DESTRUCTIVE,
    },
    guarded(runCloseJob),
  );

  server.registerTool(
    'update_job',
    {
      title: 'Employer: update a job',
      description:
        'Update fields of one of your jobs (scope jobs:write): title, description, requirements, employment_type, work_location, experience_level, salary_*, benefits, internal_job_id, expires_in_days (extend), country+city, specialization, is_active (re-open/close). Only the fields you pass are changed.',
      inputSchema: updateJobShape,
      annotations: WRITE_IDEMPOTENT,
    },
    guarded(runUpdateJob),
  );

  server.registerTool(
    'job_applications',
    {
      title: 'Employer: applications',
      description:
        'Applications to your jobs (scope applications:read): pass job_id for one job or nothing for all company jobs; optional status filter (client-side), limit, page. Shows candidate name, resume headline, cover letter and contact details exactly as ENTRA returns them — never inferred.',
      inputSchema: {
        job_id: z.string().optional().describe('One job (GET /jobs/:id/applications); omit for all (GET /employer/applications)'),
        status: applicationStatusEnum.optional().describe('pending | invitation | interview | offer | rejected | withdrawn'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
        page: z.number().int().min(1).optional(),
      },
      annotations: RO,
    },
    guarded(runJobApplications),
  );

  server.registerTool(
    'search_candidates',
    {
      title: 'Employer: search candidates',
      description:
        'Search published resumes on ENTRA (scope candidates:read): query (title/bio text), skills[] (names → ANY match), specialization, country/city, experience, work_location/remote_only, employment_type, ready_to_relocate, expected-salary bounds, has_linkedin/has_portfolio, published_within_days, limit ≤25. Returns compact profiles with a profile URL; contact fields only when ENTRA grants access. If resume access needs a plan, returns needs_subscription:true with pricing_url.',
      inputSchema: searchCandidatesShape,
      annotations: RO,
    },
    guarded(runSearchCandidates),
  );

  server.registerTool(
    'match_candidates',
    {
      title: 'Employer: match candidates to a job',
      description:
        'Rank candidates for one of your jobs (scope candidates:read): pass job_id (or job_text). Extracts skills/role/seniority deterministically (same extractor as match_jobs), runs 2–3 resume searches, dedupes and scores 0–100 with why[] (skills overlap, headline vs role, seniority, location/remote). Returns top N with fit_score, matched_skills, skill_gaps. Deterministic keyword matching — review profiles before contacting.',
      inputSchema: matchCandidatesShape,
      annotations: RO,
    },
    guarded(runMatchCandidates),
  );
}

// ---------- selftest (no MCP client needed): node dist/index.js --selftest ----------
async function selftest() {
  const text = (r: ToolResult) => r.content[0]?.text ?? '';
  const brief = (r: ToolResult, n = 500) => text(r).replace(/\s+/g, ' ').slice(0, n);
  const checks: Array<[string, () => Promise<ToolResult>, (o: Json) => boolean]> = [
    ['search_jobs', () => runSearchJobs({ query: 'machine learning', limit: 3 }), (o) => Array.isArray(o.jobs) && (o.jobs as unknown[]).length > 0],
    [
      'search_jobs(rank_by=salary, remote, US, 30d)',
      () => runSearchJobs({ query: 'engineer', remote: true, country: 'US', rank_by: 'salary', posted_within_days: 30, limit: 3 }),
      (o) => Array.isArray(o.jobs),
    ],
    [
      'match_jobs(skills)',
      () => runMatchJobs({ skills: ['python', 'pytorch', 'llm', 'rag'], target_role: 'machine learning engineer', limit: 3 }),
      (o) => Array.isArray(o.matches) && (o.matches as unknown[]).length > 0,
    ],
    ['salary_stats', () => runSalaryStats({ query: 'software engineer' }), (o) => typeof o.count_with_salary === 'number'],
    ['companies_hiring', () => runCompaniesHiring({ query: 'machine learning', limit: 5 }), (o) => Array.isArray(o.companies)],
  ];
  let failed = 0;
  for (const [name, fn, check] of checks) {
    const t0 = Date.now();
    try {
      const r = await fn();
      const o = JSON.parse(text(r)) as Json;
      const pass = !r.isError && check(o);
      if (!pass) failed++;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0} ms): ${brief(r)}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll selftest checks passed');
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  void selftest();
} else {
  // stderr only — stdout is the MCP transport
  if (EMPLOYER_FLAG && !EMPLOYER_MODE) {
    console.error(`entra-mcp: --employer given but ENTRA_API_KEY is not set — employer tools not loaded. Create a key at ${API_KEYS_URL} and export ENTRA_API_KEY.`);
  } else if (EMPLOYER_MODE) {
    console.error(`entra-mcp ${VERSION}: employer mode (key ${API_KEY.slice(0, 15)}…) — 8 candidate + 8 employer tools`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
