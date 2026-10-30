# Architecture

Submission-ready overview. Deeper detail is in the linked documents.

## Overview

Daily Edge is a multi-user web app on Supabase with one architectural commitment: **the browser
never calls a model and never holds a key.** Every AI call happens in a Deno Edge Function,
which is what makes the same logic reachable from a cron job, a Telegram webhook, a service
worker and an MCP client.

Two halves meet at a shared article pool.

**The news half is shaped by a cost constraint.** The naive design — run the pipeline per user
— makes each new user cost a full ingest. Instead, for every category any enabled user follows,
articles are fetched, deduplicated, summarised and embedded **once** into a shared `articles`
table. A per-user digest is then one Gemini call ranking that pool against the reader's profile.
The marginal cost of a user is one Flash call a day.

**The task half is shaped by front doors.** A task can be typed, parsed from a sentence, written
by an MCP client, captured from a Telegram message, or created by the chat agent — five sources,
one set of handlers, one ownership guard. `tasks.source` records which, because they carry
different amounts of human review.

## Components

**Frontend** — React 19, Vite, TypeScript, Tailwind 4, shadcn/ui, TanStack Router with SSR via
nitro, React Query for all data access under RLS. Routes: `/brief`, `/tasks`, `/news`, `/ask`,
`/insights`, `/settings`. Installable PWA with a notifications-only service worker — deliberately
not a precaching one, since the app is server-rendered.

**Database** — Postgres 17 with pgvector (HNSW), pg_cron, pg_net and Vault. RLS on every table
with `user_id = auth.uid()`. Where only _some_ columns are user-writable that is enforced by
**column grant**, because RLS cannot express "this column is ours": `news_items` grants UPDATE
on only `is_saved`/`read_at`, `api_tokens` only `revoked_at`, `topics` only `enabled`/`weight`.
→ [data-model.md](data-model.md)

**Edge Functions (12)** — `parse-task`, `ingest-news`, `build-digests`, `send-briefs`,
`check-reminders`, `push-subscribe`, `push-action`, `telegram-webhook`, `mcp`, `agent`,
`plan-day`, `topics`. → [operations.md](operations.md)

**Shared modules** — `gemini.ts` (models, structured output, embeddings, the tool loop),
`agent-tools.ts` (the ownership guard and every value coercion), `agent-registry.ts` (tool
declarations and the per-surface allowlist), `features.ts`, `notify.ts`, `tasks.ts`, `time.ts`,
`feeds.ts`, `email.ts`, `push.ts`, `telegram.ts`, `api-tokens.ts`.

## The five front doors

```
   browser          Telegram        service worker      MCP client        cron
   /ask, /tasks     @DailyEdgeBot   (tab closed)        Claude Code       (nobody)
      │                 │                │                  │              │
      │ user JWT        │ webhook secret │ HMAC token        │ de_… token   │ x-cron-secret
      ▼                 ▼                ▼                  ▼              ▼
   agent          telegram-webhook   push-action          mcp          plan-day
      │                 │                │                  │              │
      └─────────────────┴────────┬───────┴──────────────────┴──────────────┘
                                 ▼
                    _shared/agent-tools.ts
              mine() · myRow() · parseInstant() · shapeTask()
                     the ownership guard, one copy
                                 ▼
                             Postgres (RLS bypassed — service role)
```

Five different credentials, one guard. The tools run with the service role, which **bypasses
RLS**, so the resolved `user_id` is all that separates two accounts — which is why it is not
left to each handler to remember.

Each door gets a different tool set **by construction**, not by prompting: `chat` gets reads
plus create and complete; `voice` loses complete, because a device in a room may have misheard
and shows nothing back; `planner` is read-only, because it acts with nobody present.
`delete_task` is absent from all four. → [agent-layer.md](agent-layer.md)

## Data flow

**Daily news (cron, UTC)**

```
00:50  prefetch_aggregator_feeds()  pg_net fetches the aggregator tier from Postgres egress,
                                    because Google News 503s the functions' IP range
01:00  fanout_ingest_news()         one ingest-news invocation per followed category
       └─ parse → resolve → enrich → junk filter → merge → summarise → embed → upsert
01:30  fanout_build_digests()       one build-digests invocation per user
       └─ topics (vector) ∪ categories → 1 Gemini rank → link_followups()
03:00  fanout_build_digests()       again; free for any digest already `ready`
*/15   send-briefs                  emails whoever's slot is in this window — no AI call
*/15   plan-day                     agent reads tasks + brief → plan → notify()
:07…   repair-embeddings            90 vectorless articles, so a lost vector self-heals
*      check-reminders              the escalation ladder
```

**A question in `/ask`**

```
browser → agent (user JWT)
  ├─ feature gate: isEnabled(chat)?        at the entry point, not in the UI
  ├─ daily budget: < 60 today?             counted off ai_events
  ├─ generateWithTools (Gemini, ≤6 turns)
  │    └─ runTool → allowlist check → agent-tools handler → Postgres
  │         search_news → embed query → match_articles (HNSW, cosine ≥ 0.80)
  ├─ unknownCitations(): any link no tool returned?
  └─ answer + citations + tool trace + unverified links
```

**Retrieval** — one embedding model (`gemini-embedding-001`, 768 dims,
`SEMANTIC_SIMILARITY`) for articles, digest items and topic labels, so all three live in one
comparable space. Four SECURITY DEFINER RPCs, each resolving the owner internally as
`coalesce(auth.uid(), p_user_id)` so a signed-in caller can only reach their own rows whatever
it passes.

## Tech stack

| layer    | choice                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------- |
| UI       | React 19, Vite, TypeScript, Tailwind 4, shadcn/ui, TanStack Router/Query, recharts                      |
| Server   | Supabase Edge Functions (Deno), nitro SSR                                                               |
| Data     | Postgres 17, pgvector 0.8.2 (HNSW), pg_cron, pg_net, Vault                                              |
| AI       | Gemini `flash-latest` (parse/rank/agent), `flash-lite-latest` (bulk + fallback), `gemini-embedding-001` |
| Protocol | Model Context Protocol, `@modelcontextprotocol/sdk` 1.32.1                                              |
| Delivery | Gmail SMTP (465, implicit TLS), Web Push (VAPID), Telegram Bot API                                      |
| Tests    | Vitest — 122 across 9 files                                                                             |

## APIs and integrations

- **Gemini** — parsing, ranking, the agent loop, embeddings. Model ids are env-overridable.
- **Gmail SMTP** on `smtp.gmail.com:465` — Edge Functions block ports 25 and 587.
- **Telegram Bot API** — linking by one-time code, inline action buttons, free-text capture.
- **Web Push** (VAPID, `jsr:@negrel/webpush`) — the VAPID public key is _served_ by
  `push-subscribe` rather than bundled, so rotating keys needs no frontend rebuild.
- **Model Context Protocol** — in both directions. → [mcp-workflow.md](mcp-workflow.md)
- **43 RSS/Atom feeds** across 6 categories, in three trust tiers.

## Key technical decisions

The full list with reasoning is [decisions.md](decisions.md). The six that shaped the most code:

1. **One shared article pool, never a per-user pipeline.** This single decision is what makes
   open signups viable and it constrains everything downstream — including topics being vector
   queries over the existing pool rather than new feeds.
2. **The client is the intelligence (MCP) / the server is (chat).** The MCP server does no
   parsing because its caller is already a model holding the repo and the diff; the agent does
   all of it because its caller is a person typing. They share every layer underneath.
3. **The model never supplies a URL.** `build-digests` returns _indices_ into the candidate
   list; links are copied from `articles`. There is no hallucinated URL to validate because
   there is no field for one. The agent extends it: an answer's links are checked against what
   its tools returned, and anything else is reported rather than stripped.
4. **Permissions by construction.** Four surfaces, four tool sets, cron read-only. A prompt is
   a request; an allowlist is a rule.
5. **Thresholds are measured.** Two were wrong when intuited — 0.85 for follow-ups was the
   _median_; 0.60 for topics matched the entire archive.
6. **Claim before you spend, release on failure.** `brief_sends`, `task_notifications`,
   `plan_sends`. Overlapping cron ticks cannot double-send, and one SMTP hiccup cannot mark a
   day done and silently deliver nothing.

## Known limits

Named honestly in [roadmap.md](roadmap.md) and [gotchas.md](gotchas.md). The structural ones:
the Gemini free tier's 100 embed-requests-per-minute quota is the binding constraint on pool
size; current Google News `CBMi…` links cannot be resolved server-side at all; Gmail caps
sending at ~500/day; and the `agent` happy path cannot be automatically tested because no user
JWT can be minted outside a browser session.
