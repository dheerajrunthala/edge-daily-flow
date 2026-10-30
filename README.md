# Daily Edge

**Your day, run by an agent you can reach from anywhere.**

A personal task manager and AI-curated daily news brief — live at
**https://dailyedgeapp.lovable.app** with real users and seventeen days of production cron runs.

Every productivity tool assumes you come to it. Daily Edge inverts that: one agent, one tool
registry, reachable from the web app, a Telegram bot, desktop notifications, **any MCP client
you already have open**, and from nobody at all — it runs your morning on a schedule.

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
| **[CLAUDE.md](CLAUDE.md)**                       | The guidelines loaded into every agent session — 117 lines, by design.                          |
| **[docs/roadmap.md](docs/roadmap.md)**           | What is built, what is verified, and what is **not yet exercised**.                             |
| **[docs/plans/](docs/plans/)**                   | Self-contained implementation plans for the remaining work.                                     |

---

## Stack

React 19 · Vite · TypeScript · Tailwind 4 · shadcn/ui · TanStack Router (SSR via nitro) ·
Supabase (Postgres 17, pgvector/HNSW, pg_cron, pg_net, Vault, Auth, Edge Functions on Deno) ·
Google Gemini (parsing, ranking, agent tool-calling, embeddings) · Model Context Protocol ·
Gmail SMTP · Telegram Bot API · Web Push

**12 Edge Functions · 19 migrations · 122 tests · 6 skills · 6 subagents · 2 hooks**

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 122 tests, ~1.5s
npm run lint         # 0 errors (12 pre-existing shadcn warnings)
npm run build
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

## Verifying the claims

Nothing here needs to be taken on faith. With the Supabase MCP connected:

```sql
-- the agent audit trail, by front door
select surface, count(*), count(*) filter (where not ok) as failures
from mcp_tool_calls group by surface;

-- ownership: ask for user B with user A's embedding, get none of A's rows
with seed as (select user_id, embedding from news_items where embedding is not null limit 1),
     other as (select distinct user_id from news_items
               where user_id <> (select user_id from seed) limit 1)
select count(*) as leaked from seed, other,
  match_news_items(other.user_id, seed.embedding, 50, null, 0) m
where m.id in (select id from news_items where user_id = (select user_id from seed));

-- story threads found by similarity alone
select count(*) from news_items where related_item_id is not null;
```

And the guardrail that stops an agent dropping a production table:

```bash
echo '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"drop table tasks"}}' \
  | .claude/hooks/block-destructive-sql.sh; echo "exit=$?"   # exit=2
```

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
