# Daily Edge — working guidelines

An AI-powered personal productivity and news brief, live at **https://dailyedgeapp.lovable.app**
with real users' data. Multi-user, open signups.

**This file is loaded into every session, so it holds only what you must not get wrong.**
Everything else is in `docs/`, indexed below. Read the relevant doc _before_ the code — it
carries the decisions, and the code only shows the outcome.

---

## Where things are

| you are about to…                        | read first                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| change the schema                        | [docs/data-model.md](docs/data-model.md) · skill `add-migration`                        |
| touch an Edge Function                   | [docs/operations.md](docs/operations.md) · skill `deploy-and-verify-fn`                 |
| work on news, feeds or ingest            | [docs/news-pipeline.md](docs/news-pipeline.md) · skill `add-news-feed`                  |
| work on the agent, `/ask` or the planner | [docs/agent-layer.md](docs/agent-layer.md)                                              |
| work on the MCP server                   | [docs/mcp-server.md](docs/mcp-server.md) · [docs/mcp-workflow.md](docs/mcp-workflow.md) |
| work on reminders or any channel         | [docs/notifications.md](docs/notifications.md)                                          |
| write or run tests                       | skill `write-tests` · [docs/testing.md](docs/testing.md)                                |
| start a piece of work                    | skill `start-phase` · [docs/plans/](docs/plans/)                                        |
| land a change                            | skill `ship-change`                                                                     |
| debug something that does nothing        | **[docs/gotchas.md](docs/gotchas.md)**                                                  |
| pick a constant or threshold             | [docs/decisions.md](docs/decisions.md)                                                  |
| know what is and isn't verified          | [docs/roadmap.md](docs/roadmap.md)                                                      |
| understand the tooling itself            | [docs/process.md](docs/process.md) · [docs/model-routing.md](docs/model-routing.md)     |

---

## The eight rules

**1. This is production with real users' data.** Before destructive SQL — `DROP`, `DELETE`
without `WHERE`, a type change, disabling RLS — **stop and ask**. A PreToolUse hook blocks
these, but it is a net, not a decision. Prefer the reversible option: a leftover test account
gets `enabled = false`, not deleted.

**2. A 200 is not success.** Verify through the production path — `invoke_edge_function`, read
`net._http_response`, read the logs with `event_message`, then **read back the rows**. A
function has returned 200 having done nothing. Run `select now()` before choosing a log window.

**3. Deploy every function that bundles a changed `_shared/` module**, not just the one you
edited: `git grep -l 'shared/<file>' supabase/functions`. Missing this left three functions on
stale code for two days, and is how the `dayKey` bug once survived in half the project.

**4. A threshold is measured, not chosen.** Two in this schema were wrong when intuited — 0.85
for follow-up linking was the _median_, and 0.60 for topic matching matched the entire archive.
Run the distribution, read the actual pairs, and put the numbers in the migration comment.

**5. Mirrored code drifts.** Pairs are duplicated because the browser and the Deno runtime
cannot import from each other: `tz.ts`↔`time.ts`, `task-logic.ts`↔`tasks.ts`,
`queries.ts`↔`features.ts`. Touch one, check the other — or run the `mirror-drift-checker`
agent. This has already caused a production outage.

**6. A user-level property is enforced in exactly one place.** Quiet hours live inside
`notify.ts`; feature gates are read via `isEnabled()` at each function's entry point;
ownership goes through `mine()`/`myRow()`. Forgetting any of them at one call site is the bug.
A toggle that only hides a nav item is decoration.

**7. The browser never calls a model and never holds a key.** Every AI call is server-side.
That is why `topics` has no insert policy — creating one requires an embedding.

**8. Secrets never enter code, commits, or any `.md`.** Real secrets go in `.env.local`
(gitignored by `*.local`) or the platform's secret store, set with `supabase secrets set`.

**`.env` is tracked on purpose — do not "fix" it.** Lovable creates and syncs it and the build
expects it in the repo, so untracking it breaks both. It holds only `SUPABASE_URL`,
`SUPABASE_PROJECT_ID` and `SUPABASE_PUBLISHABLE_KEY` — the anon key, which ships inside the
browser bundle anyway. It identifies the project; it authorises nothing. Access is enforced by
RLS on every table plus the function grants.

Verified: the only JWT ever committed to this repo is role `anon`, and no `sbp_`/`AIza`/bot
token/`de_` value appears anywhere in history. The repo is safe to be public with `.env` in it.
Before concluding otherwise, check the role claim and run
`get_advisors(type: "security")` — and read the "revoke execute from anon" entry in
[docs/gotchas.md](docs/gotchas.md), because the grants are where a real hole actually hid.

---

## Ownership split

- **Schema** began as two hand-written migrations; every change since is a numbered file in
  `supabase/migrations/` **and** applied to the live project. Both, or the repo and the
  database disagree.
- **Lovable** built the initial UI against the existing tables and syncs two-way with the
  default branch. Keep its layout: Vite + React + TS + Tailwind + shadcn/ui, Supabase client
  in `src/integrations/supabase/`. Regenerate types after schema changes.
- **Claude Code owns everything since**: frontend, schema, Edge Functions, cron.
- `git pull` before starting and before committing — Lovable pushes without warning.

## Stack

React 19 + Vite + TS + Tailwind + shadcn/ui, TanStack Router/Query, recharts · Supabase
(Postgres, pgvector, pg_cron, pg_net, Vault, Auth, Edge Functions on Deno) · Gemini for
parsing, ranking, the agent loop and embeddings · Gmail SMTP · Telegram Bot API · Web Push ·
Model Context Protocol.

Model names and the retry policy live in `_shared/gemini.ts`. Model ids are
**env-overridable, never hard-pinned in source**: a pinned id that does not exist fails every
call with a 404, and it cannot be verified from a development environment.

Secrets the platform holds: `GEMINI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
`CRON_SECRET`, `APP_URL`, `TELEGRAM_*`, `VAPID_*`. Vault holds `project_url` and `cron_secret`
for pg_cron. Cron-invoked functions require `x-cron-secret`; user functions require a user JWT;
the MCP server uses a `de_…` token hashed into `api_tokens`.

## Tests

```bash
npm test                  # 159 cases, 11 files, ~1.5s — the gate, no setup needed
npm run test:contract     # all 12 Edge Functions boot and reach their handler
npm run test:isolation    # cross-account security; needs two de_ tokens, exits 2 if unrun
scripts/db-checks.sql     # 13 DB assertions via the Supabase MCP; a pass is silence
```

The last three exist because the riskiest code cannot be reached by a unit test: the Edge
runtime does not run locally, and RLS is database behaviour. Details and what is deliberately
not covered: [docs/testing.md](docs/testing.md).

## Commits

Prose-imperative subject, body explaining **why** — the tradeoff, the alternative rejected, the
production fact that forced it. Not Conventional Commits. These bodies are the only record of
why a threshold is 0.90 and not 0.85.

Never rewrite published history: no force push, no rebase or amend of pushed commits. It
rewrites history on Lovable's side and the owner loses their project history. One commit per
coherent change; never leave the tree dirty between steps.
`npm run build && npm run lint && npm test` green before each.

The tag `pre-hackathon` marks the state before the final push, so
`git log --oneline pre-hackathon..HEAD` is exactly that window's work.

## Tooling

Skills, subagents and hooks in `.claude/`, with a model **deliberately chosen per agent**
rather than defaulting to the most capable one. See [docs/process.md](docs/process.md) for what
each owns and [docs/model-routing.md](docs/model-routing.md) for why each runs where it does.

Deploys need `SUPABASE_ACCESS_TOKEN` in `.env.local`.
