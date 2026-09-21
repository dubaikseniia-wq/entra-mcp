# ENTRA MCP — the first agent-ready job platform

Let your AI find your job. This MCP server connects Claude, ChatGPT, Cursor, Windsurf or any MCP client — locally via `npx` or hosted at `https://mcp.entracareers.com/mcp` — to **ENTRA** — thousands of verified AI & tech jobs aggregated straight from company hiring systems (OpenAI, Anthropic, SpaceX, Stripe + 300 more). **Zero ghost jobs.**

Agents search, match, rank and prepare. **Humans decide and apply** — no spam, no auto-submission.

## Install

**Claude Code**
```bash
claude mcp add entra -- npx -y entra-mcp
```

**Claude Desktop — one-click extension (.mcpb)**
Download [`entra-mcp.mcpb`](https://github.com/dubaikseniia-wq/entra-mcp/releases/latest/download/entra-mcp.mcpb) and open it with Claude Desktop (Settings → Extensions → Install from file). No Node install needed. Employers can paste their API key in the extension settings.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`)
```json
{
  "mcpServers": {
    "entra": { "command": "npx", "args": ["-y", "entra-mcp"] }
  }
}
```

From source:
```bash
npm install && npm run build
claude mcp add entra -- node "/path/to/entra-mcp/dist/index.js"
```

Requires Node 18+. No API key needed for candidate tools — they are read-only against the public ENTRA API. Employers add one env var, see [Employer mode](#employer-mode-api-key).

Then just ask: *"Find me remote ML engineer roles paying $200K+, tell me which companies are hiring most, and prepare an application for the best fit."*

## Hosted endpoint (no install)

The same server runs at **`https://mcp.entracareers.com/mcp`** (MCP Streamable HTTP). Nothing to install, no account for candidate tools.

| Client | How |
|---|---|
| **ChatGPT** | Settings → Connectors → Create → MCP Server URL `https://mcp.entracareers.com/mcp`, authentication "None" (custom connectors need a ChatGPT plan that supports them, e.g. Plus/Pro/Business/Enterprise with developer mode) |
| **claude.ai** | Settings → Connectors → Add custom connector → URL `https://mcp.entracareers.com/mcp` |
| **Cursor** (`.cursor/mcp.json`) | `{ "mcpServers": { "entra": { "url": "https://mcp.entracareers.com/mcp" } } }` |
| **Claude Code** | `claude mcp add --transport http entra https://mcp.entracareers.com/mcp` |
| **Gemini CLI / Smithery / any Streamable HTTP client** | point it at the URL above |

**Employer mode over HTTP:** send your key on every request as `Authorization: Bearer entra_live_…` and the 8 employer tools appear for that request (Cursor: add `"headers": { "Authorization": "Bearer entra_live_…" }` next to `url`). ChatGPT and claude.ai connectors cannot send custom headers today, so there you get candidate mode — employers use the local `npx` setup with `ENTRA_API_KEY` ([Employer mode](#employer-mode-api-key)).

How the hosted server behaves:
- Stateless: every request stands alone (no sessions, no `Mcp-Session-Id`), so it scales and redeploys without breaking clients. `GET /mcp` and `DELETE /mcp` answer `405` as the spec allows.
- The `Authorization` header is used for that one request and is neither stored nor logged. No key is read from the server's environment.
- Rate limit 120 requests/minute per client IP on `/mcp`; request bodies up to 1 MB; CORS open for browser-based agents. Health: `GET /healthz`.
- Same honesty rules as below — the hosted server is just another transport for the identical tools.

## Tools

| Tool | What it does | Example call |
|---|---|---|
| `search_jobs` | Search live verified jobs. Filters: `work_location` (remote/onsite/hybrid), `country` (ISO-2), `company` (slug or name), `salary_min` (annual), `experience`, `posted_within_days`. `rank_by`: `date` (default) · `salary` · `fit` (with `profile_keywords`). Returns `total_found` + jobs with id/title/company/location/salary/published_at/url. | `{"query":"machine learning engineer","remote":true,"country":"US","salary_min":200000,"rank_by":"salary","posted_within_days":14,"limit":10}` |
| `get_job` | Full role details: description, requirements, skills, salary band, apply link | `{"job_id":"<id from search_jobs>"}` |
| `list_companies` | Who's hiring on ENTRA, with open-role counts and profile links | `{"query":"anthropic"}` |
| `match_jobs` | **AI matching, live.** Pass `resume_text` (≤8000 chars) or `skills[]`, optional `target_role`, `remote_only`, `country`, `min_salary`, `limit` (≤20). Extracts skills/role/seniority deterministically, runs 2–4 searches, dedupes, and returns a ranked list with `fit_score` (0–100), `why[]`, `matched_skills`, `skill_gaps`, `salary`, `interview_chance_hint` (high/medium/low). | `{"resume_text":"Senior ML engineer, 7 years, PyTorch, RAG, AWS…","remote_only":true,"limit":10}` |
| `match_profile` | Backward-compatible alias of `match_jobs` (`skills[]`, `role_hint`) | `{"skills":["python","llm","rag"],"role_hint":"ML engineer"}` |
| `salary_stats` | Salary stats for a role from listings that publish a band: `count_with_salary`, min / p25 / median / p75 / max per currency (annualized; USD as USD-equivalent, other currencies as-is), top 5 companies | `{"query":"software engineer","country":"US"}` |
| `companies_hiring` | Which companies are hiring for a role right now: open-role counts, sample titles, latest post date, verified flag, profile URLs | `{"query":"AI engineer","remote_only":true,"limit":15}` |
| `prepare_application` | Human-in-the-loop apply link + checklist | `{"job_id":"<id>"}` |

Every job in every response carries `verified: true`, a salary band when the company lists one, and an apply URL of the form `https://entracareers.com/{country}/vacancies/{id}?utm_source=agent&utm_medium=mcp` — we welcome agent traffic.

### Sample: `match_jobs`
```json
{
  "source": "ENTRA — verified roles aggregated from company ATSs. Finds and ranks; you apply.",
  "profile": { "skills_used": ["machine learning", "python", "rag", "llm", "pytorch", "aws"], "target_role": "machine learning engineer", "seniority": "6+ yrs (7+ years mentioned)" },
  "queries_run": ["machine learning engineer", "python", "rag", "llm"],
  "candidates_considered": 142,
  "matches": [
    {
      "title": "Machine Learning Engineer, Inference",
      "company": "OpenAI",
      "location": "San Francisco, United States",
      "work_location": "remote",
      "salary": "$295K–555K/yr",
      "url": "https://entracareers.com/us/vacancies/…?utm_source=agent&utm_medium=mcp",
      "fit_score": 88,
      "interview_chance_hint": "high",
      "why": [
        "Skills: 5/6 matched (machine learning, python, llm, pytorch, aws)",
        "Title match: \"Machine Learning Engineer, Inference\" fits \"machine learning engineer\"",
        "Seniority: job asks 6+ yrs, you read as 6+ yrs — match",
        "Remote role (as requested)",
        "Salary band listed: $295K–555K/yr"
      ],
      "skill_gaps": ["rag"]
    }
  ]
}
```

## Honesty note

- Matching is **deterministic** — a keyword dictionary plus rules, no LLM in the loop. `fit_score` is explainable, not a prediction; `interview_chance_hint` is derived from `fit_score` only (never a made-up percentage).
- `salary_stats` uses **listed bands only** — roles without a published band are excluded, and nothing is estimated.
- `search_jobs` `rank_by: "salary"` returns salaried listings only; `posted_within_days` is applied client-side over the most recent 500 matches.
- Nothing is submitted on your behalf. `prepare_application` returns a link and a checklist; the human applies.

## Employer mode (API key)

Same package, one env var: with `ENTRA_API_KEY` set, the 8 candidate tools stay and **8 employer tools** are added — post jobs, manage listings, read applications, search and match candidates for **your company**.

1. Create a key at [entracareers.com/employer/profile?tab=api-keys](https://entracareers.com/employer/profile?tab=api-keys) (pick the scopes you need; the key is shown once).
2. Connect:

**Claude Code**
```bash
export ENTRA_API_KEY="entra_live_…"
claude mcp add entra -e ENTRA_API_KEY=$ENTRA_API_KEY -- npx -y entra-mcp --employer
```

**Claude Desktop / Cursor / Windsurf**
```json
{
  "mcpServers": {
    "entra": {
      "command": "npx",
      "args": ["-y", "entra-mcp", "--employer"],
      "env": { "ENTRA_API_KEY": "entra_live_…" }
    }
  }
}
```

Then ask: *"Post a Senior Sales Manager job in Dubai — hybrid, 15–22K AED/month, 45 days — then show me the 5 best candidates for it and who has already applied."*

How it behaves:
- The key is read from the environment **only** (never from arguments). Without a key the employer tools are not registered; `--employer` alone just prints a hint on stderr.
- Nothing is called at startup. The first employer call resolves your company and scopes via `GET /employer/api-keys/me` and caches them.
- Only employer endpoints receive the bearer header; public lookups (countries, cities, specializations, job details) are made anonymously.
- Rate limit is 120 requests/minute per key; a `429` is retried once after `retry-after`.

### Employer tools

| Tool | Scope | What it does | Example call |
|---|---|---|---|
| `employer_whoami` | any | Company, key name/prefix, granted scopes, which tools are usable | `{}` |
| `post_job` | `jobs:write` | Publish a job. Human-friendly input: `title`, `description`, `employment_type` (full_time/part_time/contract/freelance/internship), `work_location` (remote/onsite/hybrid), `country` (ISO-2 or name), `city` (name — required by ENTRA even for remote roles), optional `specialization` (free text → best active match, defaults to the title), `experience_level`, `salary_min/max/currency/period`, `benefits`, `skills` (names), `internal_job_id`, `expires_in_days` (default 30). Returns the public URL, manage URL and every resolution made (`resolved`, `notes`). | `{"title":"Senior Sales Manager","description":"…","employment_type":"full_time","work_location":"hybrid","country":"AE","city":"Dubai","salary_min":15000,"salary_max":22000,"salary_currency":"AED","salary_period":"monthly","expires_in_days":45}` |
| `my_jobs` | `jobs:read` | Your company's jobs: `status` active (default) / closed / all, `search`, `limit`, `page`. Status, salary, applications count, expiry, URLs. | `{"status":"active"}` |
| `update_job` | `jobs:write` | Change a subset of fields: title, description, requirements, employment/work location, experience, salary, benefits, `expires_in_days` (extend), `country`+`city`, `specialization`, `is_active` (re-open) | `{"job_id":"…","salary_max":25000,"expires_in_days":60}` |
| `close_job` | `jobs:write` | Unpublish a job. Without `confirm:true` returns a preview only; with it, `PATCH {isActive:false}` (reversible) | `{"job_id":"…","confirm":true}` |
| `job_applications` | `applications:read` | Applications to one job (`job_id`) or all company jobs; optional `status` (client-side), `limit`, `page`. Candidate, resume headline, cover letter, contact details exactly as returned | `{"job_id":"…","status":"pending"}` |
| `search_candidates` | `candidates:read` | Published resumes: `query`, `skills[]` (ANY), `specialization`, `country`/`city`, `experience`, `work_location`/`remote_only`, `employment_type`, `ready_to_relocate`, expected-salary bounds, `has_linkedin`/`has_portfolio`, `published_within_days`, `limit` ≤25 | `{"query":"sales manager","country":"AE","experience":"3_6_years"}` |
| `match_candidates` | `candidates:read` | Rank candidates for `job_id` (or `job_text`): deterministic extraction of skills/role/seniority, 2–3 resume searches, `fit_score` 0–100 with `why[]`, `matched_skills`, `skill_gaps` | `{"job_id":"…","limit":10}` |

### Structured outcomes (no surprises)

| Situation | What you get |
|---|---|
| Key invalid / revoked | `{"error":…,"code":"AUTH_ERROR","status":401,"hint":"…create a new key at …/employer/profile?tab=api-keys"}` |
| Key lacks a scope | `{"code":"MISSING_SCOPE","scope":"jobs:write",…}` — checked locally before any request |
| No free vacancy slot | `post_job` → `{"needs_subscription":true,"pricing_url":"https://entracareers.com/employer/pricing","note":"Founding plan from $10"}` (not an error) |
| Resume database needs a plan | `search_candidates` / `match_candidates` → `{"needs_subscription":true,…,"note":"Resume Access"}` |
| Rate limited | retried once, then `{"code":"API_KEY_RATE_LIMIT_EXCEEDED","status":429,…}` |
| Validation failed | `{"status":400,"validation":[{field,message}]}` |

### Honesty notes (employer)
- `match_candidates` is **deterministic keyword scoring** (skills overlap, headline vs role, seniority, location/remote) — explainable, not a prediction. Review profiles before contacting anyone.
- Contact details (email, phone, WhatsApp, LinkedIn, portfolio) are shown **only when ENTRA returns them** — i.e. the candidate applied to your job or accepted your invitation. Nothing is inferred or scraped.
- `post_job` reports every guess it made: city / specialization match quality, a detected or defaulted `experience_level` (`1_3_years` if undetectable), and `salary_period` defaulting to **monthly** (the ENTRA default — pass `"yearly"` for annual figures).
- Nothing is deleted: `close_job` sets `isActive:false` and can be undone with `update_job {is_active:true}`. Application status changes are not available through API keys — use the employer dashboard.

## Why ENTRA is agent-ready (and others aren't)
- LinkedIn bans agents. Indeed's MCP is search-only. Tools that scrape break on CAPTCHAs.
- ENTRA **owns the inventory** — verified jobs from company ATSs — so agents get clean, legal, structured access with consented apply links.
- Every listing: `verified: true` + salary bands + `utm_source=agent` (we welcome agent traffic).

AI matching is live via `match_jobs` — connect your profile at [entracareers.com](https://entracareers.com).

## Roadmap
- Application status changes and invitations through API keys (today: read-only applications).
- OAuth on the hosted endpoint, so ChatGPT / claude.ai connectors can use employer mode without a local install.

Employers: [entracareers.com/employer/pricing](https://entracareers.com/employer/pricing) — Founding plan from $10.

## Links
- Developers: [entracareers.com/developers](https://entracareers.com/developers)
- For AI agents: [entracareers.com/ai-agents](https://entracareers.com/ai-agents)

## Development
```bash
npm run build           # tsc → dist/
npm run selftest        # calls the live API directly, no MCP client (candidate tools)
npm run smoke           # spawns the server over stdio with the MCP SDK client and exercises every candidate tool (live API)
npm run smoke:employer  # employer mode against an in-process mock of the employer API (no network, no real key)
npm run smoke:http      # starts dist/http.js on a random port and drives it with the SDK's Streamable HTTP client (live API + fake employer key)
npm run start:http      # hosted transport locally: http://localhost:8080/mcp (PORT, HOST, RATE_LIMIT_PER_MINUTE, TRUST_PROXY, MCP_ALLOWED_HOSTS)
npm run bundle          # builds dist-bundle/entra-mcp.mcpb (Claude Desktop extension / Smithery local bundle) from manifest.json
docker build -t entra-mcp . && docker run -p 8080:8080 entra-mcp   # the image the hosted endpoint runs (node:22-alpine, dist/http.js)
```
Layout: `src/server.ts` builds the server (`createServer({ apiKey? })` — tools + per-request key context), `src/index.ts` is the stdio entry (`npx entra-mcp`), `src/http.ts` the hosted Streamable HTTP entry.

Environment: `ENTRA_API_KEY` (stdio only — enables employer mode), `ENTRA_API_URL` (default `https://entracareers.com/api`), `ENTRA_SITE_URL` (default `https://entracareers.com`).

MIT © ENTRA


## Privacy Policy

This server sends only your tool inputs to the public ENTRA API (https://entracareers.com/api). No telemetry, no third-party services. Locally (`npx entra-mcp`) employer mode uses your API key from the `ENTRA_API_KEY` environment variable; on the hosted endpoint (https://mcp.entracareers.com/mcp) the key comes from the `Authorization` header of each request, is forwarded only to ENTRA employer endpoints, and is never stored or logged. The hosted server keeps no sessions or request history beyond a short access log (method, tool name, status, timing). Full policy: https://entracareers.com/privacy-policy
