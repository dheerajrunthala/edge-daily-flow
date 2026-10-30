# Daily Edge

**Your day, run by an agent you can reach from anywhere.**

A personal task manager and AI-curated daily news brief — live at
**https://dailyedgeapp.lovable.app** with real users and production cron runs every day since
2026-10-12.

Every productivity tool assumes you come to it. Daily Edge inverts that: one agent, one tool
registry, reachable from the web app, a Telegram bot, desktop notifications, **an Alexa
device you talk to**, **any MCP client you already have open**, and from nobody at all — it
runs your morning on a schedule.

---

## What makes it unusual

**It is agent-addressable by construction.** The app exposes its own MCP server, so Claude Code
— already holding your repo, your branch and your diff — files its own follow-up tasks, with the
repo name, the file paths and a "Next: …" line, without you leaving the terminal. The same tool
handlers serve the chat UI, the Telegram bot and the cron planner.

**What you follow is a vector query, not a dropdown.** Type "Kubernetes security" or
"semiconductor manufacturing in India" and it is embedded once and matched by meaning against
every article in the pool. No new feed, no extra cost per digest, and it shows you what the
phrase would have matched _before_ you commit — including telling you honestly when nothing in
the archive is close.

**Stories thread themselves.** Today's article points back at the earlier one it continues,
found by cosine similarity rather than keywords. The Jio IPO came out as a real chain:
grey-market premium on Oct 15, again on Oct 18, listing day on Oct 25.

**Each door has different permissions by construction.** Not by prompting — by allowlist. The
chat can complete a task; a voice device cannot, because it may have misheard and shows nothing
back; the cron planner has no write tools at all, because it acts with nobody present.

**Citations are checked, not trusted.** Every retrieval tool records what it returned, and any
URL in an answer that no tool produced is reported to the user with a warning. A fabricated link
is worse than a wrong summary — the summary is visibly an opinion, a URL looks like a fact.

---

## Where to look

|                                                  |                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **[docs/architecture.md](docs/architecture.md)** | System overview, data flow, tech stack, key decisions. Start here.                              |
| **[docs/mcp-workflow.md](docs/mcp-workflow.md)** | Model Context Protocol in _both_ directions — as the development loop and as a product surface. |
| **[docs/decisions.md](docs/decisions.md)**       | Decisions worth not relitigating, and every measured constant with how it was measured.         |
| **[docs/process.md](docs/process.md)**           | The skills, subagents and hooks in `.claude/`, and the findings each produced.                  |
| **[docs/README.md](docs/README.md)**             | Full documentation map.                                                                         |
| **[CLAUDE.md](CLAUDE.md)**                       | The guidelines loaded into every agent session — 151 lines, by design.                          |
| **[docs/roadmap.md](docs/roadmap.md)**           | What is built, what is verified, and what is **not yet exercised**.                             |
| **[docs/plans/](docs/plans/)**                   | Self-contained implementation plans for the remaining work.                                     |

---

## Stack

React 19 · Vite · TypeScript · Tailwind 4 · shadcn/ui · TanStack Router (SSR via nitro) ·
Supabase (Postgres 17, pgvector/HNSW, pg_cron, pg_net, Vault, Auth, Edge Functions on Deno) ·
Google Gemini (parsing, ranking, agent tool-calling, embeddings) · Model Context Protocol ·
Gmail SMTP · Telegram Bot API · Web Push

**13 Edge Functions · 20 migrations · 240 tests · 9 skills · 8 subagents · 2 hooks**

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 240 tests across 13 files, ~2s
npm run lint         # 0 errors (12 pre-existing shadcn warnings)
npm run build
npm run verify       # checks every claim this README makes — see below
```

The frontend needs `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` — both already in `.env`,
because both are designed to be public. Everything else is server-side: the Gemini key, SMTP
credentials, the Telegram bot token and the VAPID keys live only in the platform's secret store,
because **the browser never calls a model and never holds a key.**

Deploying functions needs a Supabase access token in `.env.local` (gitignored):

```bash
npx supabase functions deploy <name> --project-ref <ref>
```

See [docs/operations.md](docs/operations.md).

---

## Tests

```bash
npm test              # 240 tests, 13 files, ~2s — no network, no credentials
npm run lint          # must be 0 errors
npm run build
```

`npm test` is the gate and needs no setup. Three further suites exist because the most
dangerous code here cannot be reached by a unit test — the Deno Edge runtime does not run
locally, and RLS is database behaviour:

| command                  | covers                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`               | 240 cases: parsing, dates, grouping, the `.ics` export, Insights aggregation, tool allowlists, hallucinated-citation detection, and browser↔Edge parity for the duplicated modules                                                                                                                    |
| `npm run test:contract`  | all **13 Edge Functions boot** and reach their handler — proven by each refusing correctly (wrong cron secret, invalid bearer, missing HMAC). Catches the `BOOT_ERROR` class, which is invisible to unit tests and has bitten twice                                                                   |
| `npm run test:isolation` | cross-account security: every one of account A's ids must read as _not found_ to account B's token, and A's rows must be unchanged after. Needs `DAILY_EDGE_TOKEN_A` and `DAILY_EDGE_TOKEN_B` from Settings → Integrations; **exits 2 when unrun**, so a skipped security check cannot read as a pass |
| `npm run verify`         | all of the above that can run here, plus the local checks, as one PASS/FAIL table per claim — see [Verifying the claims](#verifying-the-claims). Never reports a skipped check as a pass                                                                                                              |
| `scripts/db-checks.sql`  | 13 assertions, run by `npm run verify` or through the Supabase MCP: RLS on every table, column grants, no `anon`-executable definer function, cross-account scoping, HNSW operator classes, the measured 0.90 follow-up threshold, and the cron schedule. **A pass is silence.**                      |

The two network suites hit the live project. `db-checks.sql` assertion 7b writes inside a
savepoint and rolls back — then re-counts to prove it did — so avoid running it while a digest
build is in flight.

Full strategy, including what is deliberately **not** covered: [docs/testing.md](docs/testing.md).

## Verifying the claims

Nothing here needs to be taken on faith, and nothing needs to be pasted into a console:

```bash
npm run verify              # 13s here. Add -- --local to skip everything needing the network.
```

One row per claim, with the real number beside it. On this machine, just now:

```
── local — no network, no credentials
PASS  the unit suite passes with no setup                  240 tests, 13 files, 1.89s
PASS  eslint reports no errors                             0 errors, 12 warnings (shadcn's, in components/ui)
PASS  the destructive-SQL hook holds in both directions    13/13 — 7 blocked, 6 let through
PASS  every subagent declares a model, none is opus        8 agents — 4 haiku, 4 sonnet
PASS  every Edge Function pins verify_jwt in config.toml   13/13 functions listed
PASS  every relative link in the docs resolves             103 links checked
PASS  the README's headline counts are true                all 6 match
PASS  CLAUDE.md is as short as the docs say                151 lines, agreed by every document that says so

── deployed — needs network, no credentials (the anon key is public by design)
PASS  every Edge Function boots and reaches its handler    13/13 functions booted

── live database — needs SUPABASE_ACCESS_TOKEN (.env.local, same one deploys use)
PASS  the 13 database assertions hold                      scripts/db-checks.sql returned no rows — a pass is silence
PASS  no cross-account leak through match_news_items       0 of account A's rows returned when asking as account B
PASS  every agent tool call is recorded with its surface   92 calls across 3 surfaces (mcp/planner/voice), 1 failed
PASS  stories thread themselves by similarity alone        15 items point at an earlier one, across 12 digests

── cross-account — needs two accounts' de_ tokens
SKIP  one account's MCP token cannot touch another's rows  no DAILY_EDGE_TOKEN_A/_B — mint them in Settings → Integrations

13 passed, 1 skipped
```

Three things about that output are the point:

**A skipped check is never a pass.** Each group says which credential it needs and how to get
it, the skip count is printed separately from the pass count, and the exit code counts
failures only. With no `SUPABASE_ACCESS_TOKEN` the four live rows go to `SKIP` with the
reason on the line; they never silently go green.

**The README's own numbers are one of the checks.** The counts line under [Stack](#stack) is
parsed and compared against the repo, and so is the CLAUDE.md line count that four
documents quote — so this file going stale is a test failure rather than something a reader
has to catch.

**The database assertions really run.** `scripts/db-checks.sql` is posted to
`POST /v1/projects/{ref}/database/query` — the endpoint the hosted Supabase MCP server calls
underneath `execute_sql` — so the 13 assertions that were previously only reachable from an
agent session now run from a shell. `scripts/verify/live-sql.mjs` re-checks the
destructive-SQL deny list before sending anything, because a script posting SQL over HTTPS is
a second door into the same production database with the PreToolUse hook nowhere near it.

`git log --oneline pre-hackathon..HEAD` is the recent work; the commit **bodies** carry the
reasoning, including why a similarity threshold is 0.90 and not the 0.85 originally specified.

---

## Honest limitations

Kept current in [docs/roadmap.md](docs/roadmap.md) and [docs/gotchas.md](docs/gotchas.md). The
ones that matter:

- The Gemini **free tier caps embeddings at 100 requests/minute**, and `batchEmbedContents`
  counts each _text_. That is the binding constraint on pool size; a repair job now drains any
  shortfall every ten minutes so a lost vector is no longer permanent.
- Current Google News `/rss/articles/CBMi…` links **cannot be resolved server-side at all** —
  the id is opaque and the redirect is client-side JS. Those items keep the redirect and are
  labelled "via Google News".
- Gmail caps sending at ~500/day. Fine now; sending is behind one module so swapping to Resend
  is a one-file change.
- The `agent` function's happy path **is not automatically tested**: a user JWT cannot be minted
  outside a browser session. Its refusals are tested.

---

Built with [Claude Code](https://claude.com/claude-code); the initial UI scaffold came from
[Lovable](https://lovable.dev), which syncs two-way with the default branch.
