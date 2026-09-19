#!/usr/bin/env node
/**
 * ENTRA MCP Server — the first agent-ready job platform.
 * Read-only wrapper over the public ENTRA REST API (entracareers.com).
 *
 * Tools: search_jobs · get_job · list_companies · match_jobs · match_profile (alias)
 *        · salary_stats · companies_hiring · prepare_application
 *
 * Human-in-the-loop by design: agents find and rank, humans decide and apply.
 * Matching is deterministic (keyword dictionary + rules) — no LLM, no invented numbers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.2.0';
const API = (process.env.ENTRA_API_URL ?? 'https://entracareers.com/api').replace(/\/+$/, '');
const SITE = (process.env.ENTRA_SITE_URL ?? 'https://entracareers.com').replace(/\/+$/, '');
const UTM = 'utm_source=agent&utm_medium=mcp';
const SOURCE_NOTE = 'ENTRA — verified roles aggregated from company ATSs. Finds and ranks; you apply.';

// ---------- API layer ----------
type Json = Record<string, unknown>;
type Params = Record<string, string | number | boolean | undefined>;

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiGet<T = Json>(path: string, params: Params = {}): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `entra-mcp/${VERSION} (+${SITE})` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as Json;
      detail = typeof body.message === 'string' ? body.message : '';
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res.status, `ENTRA API ${res.status} for ${path}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

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
  city?: { nameEn?: string } | null;
  country?: { id?: string; nameEn?: string; slug?: string; code?: string } | null;
  specialization?: { nameEn?: string; slug?: string } | null;
  skills?: Array<{ nameEn?: string; name?: string }> | null;
  publishedAt?: string | null;
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
        for (const c of list) if (c.code) codeById.set(c.id, c.code);
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

function jobUrl(j: ApiJob): string {
  const cc = (codeById.get(j.country?.id ?? '') ?? j.country?.code ?? 'us').toLowerCase();
  return `${SITE}/${cc}/vacancies/${j.id}?${UTM}`;
}

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
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
const guarded =
  <A>(fn: (a: A) => Promise<ToolResult>) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
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

// ---------- MCP server ----------
const server = new McpServer({ name: 'entra', version: VERSION });
const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

server.registerTool(
  'search_jobs',
  {
    title: 'Search ENTRA jobs',
    description:
      'Search 15,000+ verified AI & tech jobs on ENTRA (aggregated directly from company hiring systems — zero ghost jobs). Filters: work location, country, company, annual salary, experience, posted_within_days. rank_by date | salary | fit (fit needs profile_keywords). Returns total_found and live roles with salary bands and apply links.',
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
