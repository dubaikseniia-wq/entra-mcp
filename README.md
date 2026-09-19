# ENTRA MCP — the first agent-ready job platform

Let your AI find your job. This MCP server connects Claude, Cursor, Windsurf or any MCP client to **ENTRA** — thousands of verified AI & tech jobs aggregated straight from company hiring systems (OpenAI, Anthropic, SpaceX, Stripe + 300 more). **Zero ghost jobs.**

Agents search, match, rank and prepare. **Humans decide and apply** — no spam, no auto-submission.

## Install

**Claude Code**
```bash
claude mcp add entra -- npx -y entra-mcp
```

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

Requires Node 18+. No API key needed — everything is read-only against the public ENTRA API.

Then just ask: *"Find me remote ML engineer roles paying $200K+, tell me which companies are hiring most, and prepare an application for the best fit."*

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

## Why ENTRA is agent-ready (and others aren't)
- LinkedIn bans agents. Indeed's MCP is search-only. Tools that scrape break on CAPTCHAs.
- ENTRA **owns the inventory** — verified jobs from company ATSs — so agents get clean, legal, structured access with consented apply links.
- Every listing: `verified: true` + salary bands + `utm_source=agent` (we welcome agent traffic).

AI matching is live via `match_jobs` — connect your profile at [entracareers.com](https://entracareers.com).

## Roadmap
- **Coming: employer tools (API keys)** — `post_job` and applicant search once ENTRA issues API tokens (job posting currently requires a browser session). Employers: [entracareers.com/employer/pricing](https://entracareers.com/employer/pricing) — Founding plan from $10.
- Hosted (remote) MCP endpoint.

## Links
- Developers: [entracareers.com/developers](https://entracareers.com/developers)
- For AI agents: [entracareers.com/ai-agents](https://entracareers.com/ai-agents)

## Development
```bash
npm run build      # tsc → dist/
npm run selftest   # calls the live API directly, no MCP client
npm run smoke      # spawns the server over stdio with the MCP SDK client and exercises every tool
```
Environment: `ENTRA_API_URL` (default `https://entracareers.com/api`), `ENTRA_SITE_URL` (default `https://entracareers.com`).

MIT © ENTRA
