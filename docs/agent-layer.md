# The agent layer

The conversational door, the autonomous planner, vector retrieval, topics and the feature switches — everything added in Phase 8.

The short version: the MCP server does no parsing because its caller is already a model; the agent does all of it because its caller is a person. They share everything underneath.

### The agent layer (Phase 8)

The fifth front door, and the first one with a model on _our_ side of it.

The MCP server is built on "the client is the intelligence": it does no parsing because an
MCP client is already a model holding the conversation. The agent is the opposite case —
the caller is a person typing or dictating, so the thinking has to happen here. **That is
the only difference between them.** Both sit on the same ownership guard, the same date
coercion and the same task shaping, so they differ in who thinks, not in what is true.

#### What is shared, and why those parts specifically

`_shared/agent-tools.ts` owns the ownership guard (`mine`/`myRow`), every value coercion
(`parseInstant`, `parseRemindBefore`, `snapToLocalMidnight`, `parseDate`, `sanitizeSearch`),
the task shape, tag creation, and `loadUserCtx`. `mcp/tools.ts` imports all of it and keeps
only what is genuinely MCP: the zod schemas, the `ToolResult` wrapper, and the `register()`
rate-limit and audit wrapper.

The 13 MCP handler _bodies_ were deliberately **not** moved. Moving 940 more lines of
production-verified registration would be a large change for an architectural tidy, while
the parts that can drift _dangerously_ are the ones that did move. Two copies of
`parseInstant` would quietly book 2:30pm for an Asia/Kolkata user who said 9am.

`Ctx` carries **no credential**. The MCP server extends it with the API token `register()`
needs; the chat agent resolves the same shape from a session JWT; the planner builds it from
a user id on a cron tick. A tool body cannot tell them apart, which is the point — one that
could would eventually behave differently.

#### Surfaces get different tools by construction

A prompt is a request; an allowlist is a rule. `SURFACE_TOOLS` in `_shared/agent-registry.ts`:

| surface    | tools                                   | why                                                          |
| ---------- | --------------------------------------- | ------------------------------------------------------------ |
| `chat`     | reads + `create_task` + `complete_task` | the user sees exactly what happened                          |
| `voice`    | reads + `create_task`                   | a device in a room may have misheard, and shows nothing back |
| `telegram` | reads + `create_task` + `complete_task` | a chat log is a record                                       |
| `planner`  | reads only                              | cron, with nobody present to notice a mistake                |

`delete_task` is absent from all four. The MCP server has it because a developer's editor
can confirm first; "delete the thing about the client" said to a speaker is not a
confirmation.

The allowlist is checked at declaration time **and** inside `runTool`. Belt and braces on
purpose: a model hallucinating a tool name it was never given would otherwise land in the
dispatcher's default branch, and that branch is holding the user's id.

#### Citations are checked, not trusted

Every retrieval tool records what it returned into `run.citations`. `unknownCitations()`
then reports any URL in the answer that was not among them, and the chat UI renders those
with a warning rather than stripping them. A fabricated link is worse than a wrong summary:
the summary is visibly the model's opinion, a URL looks like a fact. Reporting rather than
stripping also means it lands in the logs instead of only in a user's confusion.

#### `mcp_tool_calls.surface`

Two of the four doors carry no API token, so a row with `token_id` null would be
unattributable. `surface` is `'mcp' | 'chat' | 'voice' | 'telegram' | 'planner'`, defaulted
to `'mcp'` so the pre-existing rows stay true. It is the only record of what an agent did
while nobody was watching.

#### Gemini tool-calling gotchas (these cost a whole debugging session)

- **`parameters` must be omitted entirely for a no-argument tool.** Declaring
  `{ type: "object", properties: {} }` makes `generateContent` **hang** — not 400, not 503;
  the request never returns and the platform kills the invocation with `IDLE_TIMEOUT`.
  `get_brief` was the only such tool and `plan-day` the only surface that could reach it.
  `sanitizeDeclarations()` strips an empty schema defensively, because the symptom is so far
  from the cause.
- **A hang is different information from a 503.** A 503 means "busy, retry in a second"; a
  hang means the request went in and nothing came back. So a timeout **abandons that model
  immediately** rather than spending four more attempts rediscovering it — which is what
  leaves budget to try the fallback, the thing that actually worked.
- The model's turn must be echoed back verbatim before the `functionResponse` parts, or
  Gemini rejects the response as unanchored.
- The last turn drops the tools entirely. That is what forces prose out of a model which
  would otherwise reach for one more lookup, so hitting the turn cap still produces a reply.
- Several calls can arrive in one turn; they run **in sequence**, because they share one
  database and "complete this, then list what's left" has to see its own write.

#### Gemini capacity is a real operational constraint

`gemini-flash-latest` is an alias, so we share its capacity with everyone pointing at the
same one, and it answers 503 "high demand" often enough to have lost three days of digests
(2026-10-24, -25, -28). The policy that works:

- **5 attempts, backing off 1s/2s/4s/8s**, jitter 500ms so the per-category ingest fan-out
  does not retry in lockstep and re-create the spike. The old policy — 3 attempts over about
  two seconds — was a formality, not a retry.
- **`GEMINI_FALLBACK_MODEL` = `gemini-flash-lite-latest`**, a different capacity pool, for 2
  more attempts. A digest ranked by the cheaper model is enormously better than no digest.
  Verified: plan-day's successful run was answered by the fallback.
- **Per-call deadline (25s) and a total budget (90s).** An unbounded fetch inside a 150s
  runtime is not a long wait, it is a lost error.
- `embedBatch` gets the same policy, **plus the quota rule below**, which is the one that
  actually mattered.

#### The embedding quota is the binding constraint, not capacity

This looked like capacity flakiness for two weeks and was not. The Gemini **free tier allows
100 `embed_content` requests per minute**, and `batchEmbedContents` counts each _text_ as a
request rather than each call. So:

- a day's pool is 130–150 articles across six categories that `fanout_ingest_news()` starts
  **simultaneously** — comfortably over the limit, every morning;
- exponential backoff cannot fix a per-minute quota. 1+2+4+8s is 15 seconds of patience for a
  window the API itself says will reset in up to 60.

Three consequences, all now handled:

1. **Believe the API.** A quota 429 carries the wait in `RetryInfo.retryDelay` and in prose
   ("Please retry in 49.215166941s"). `retryAfterMs()` parses either and honours it, capped at
   55s so an unbounded wait cannot eat the 150s runtime. Guessing was the bug.
2. **Size work to the quota, not the wall clock.** `EMBED_REPAIR_LIMIT = 90`, not 200. Proof
   it is the right shape: a run asked to repair 200 repaired **exactly 100** and was refused
   the rest.
3. **A lost vector must not be permanent.** Articles are upserted with `ignoreDuplicates` on a
   unique url, so an article pooled without a vector was skipped by every later run and stayed
   vectorless forever — invisible to topic matching and follow-up linking. That had reached
   **797 of 2,651 articles (30% of the archive)**, going back to 2026-10-13. The
   `repair-embeddings` cron (`*/10`, 90 per run) clears a backlog at 540/hour and then costs
   one indexed query returning nothing. That is what makes "pooled without a vector" a
   recoverable state rather than a permanent one.

#### The structural gap, and how it was closed

`build-digests` used to iterate users inside one invocation with no per-user time budget, so
the slowest user decided whether anybody else got a digest. On 2026-10-28 a leftover QA
account spent 140s on Gemini retries and the real user's row was claimed at 01:32:21 and
killed at 01:32:33 — which is why it sat in `pending` and never reached `failed`: nothing
survived to write a status.

`fanout_build_digests()` fixes it the way `fanout_ingest_news()` fixed the other half — one
`net.http_post` per user, each with its own 150s budget. It accepts the same tradeoff: every
user's ranking call now goes out at once rather than in sequence, which the retry policy and
the fallback model are what make survivable.

Two things that were _also_ wrong and are easy to miss:

- **A dead run had nothing to retry it.** Cron fired once at 01:30, so a killed invocation
  left a `pending` row that no later run could reach — the next day's run builds the next
  day's digest. `build-digests-retry` at 03:00 calls the same fan-out, which costs nothing for
  a digest already `ready` (`buildForUser` returns early before spending) and is a real retry
  for one that is not. Verified: a fan-out over a `ready` digest added zero Gemini calls.
- **`plan-day` was never scheduled at all.** It was written, deployed, documented in the cron
  table above and verified end to end by hand — and then given no `cron.job` row, so the
  autonomous planner had only ever run when somebody invoked it manually. Scheduled now.

### Vector retrieval (Phase 8)

Embeddings existed from Phase 3 and nothing ever read one. Now:

- **HNSW indexes** on `articles.embedding`, `news_items.embedding` and `topics.embedding`.
  HNSW over IVFFlat because IVFFlat's lists need retuning as a table grows and HNSW needs no
  training pass. `vector` lives in the **`extensions`** schema here, so every function pins
  `set search_path = public, extensions` or the parameter type will not resolve.
- `match_news_items`, `match_articles`, `match_topics_pool`, `link_followups` — all SECURITY
  DEFINER with the owner resolved as `coalesce(auth.uid(), p_user_id)`, so a signed-in caller
  can only ever reach their own rows whatever it passes, while the service-role path still
  works. `anon` is revoked, so the null-uid branch is unreachable from the publishable key.

#### Both thresholds were wrong when guessed — measure, don't intuit

- **Follow-up linking: 0.90, not the 0.85 this file used to specify.** Over 316 embedded
  items the median nearest cross-digest neighbour sat at **0.8494**, so 0.85 badged 157 of
  316 — half the feed. Reading the pairs by band: 0.82–0.89 is "same category, unrelated
  story", 0.90+ is genuinely one thread. 0.90 keeps about 11%.
- **The link must point backwards.** `digest_id <> digest_id` alone is symmetric, so an item
  would cite tomorrow's coverage as the story it follows up on. `prior.created_at <
n.created_at` is what makes the badge mean what it says.
- **Topic matching: 0.80.** `gemini-embedding-001` at 768 dims compresses _everything_ into
  roughly 0.75–0.88, so a 0.5 floor ("at least half related") matches the entire archive.
  Measured over seven probe labels: covered topics peaked at 0.8758 / 0.8498 / 0.8448 /
  0.8401 (dev tooling, RBI policy, Kubernetes security, Indian semiconductors), uncovered
  ones at 0.7906 / 0.7817 / 0.7735 (Formula 1, Indian cricket team, cricket results). 0.80
  sits in that gap so an uncovered topic returns **nothing** rather than the four
  least-unrelated stories. 0.82 was rejected: it cuts a well-covered topic from 12 to 3.
- **Topic labels must be embedded with `taskType: "SEMANTIC_SIMILARITY"`**, matching what
  ingest-news uses for articles. `RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT` are deliberately
  asymmetric; mixing them gives no error, just plausible-looking matches that are wrong.

### Topics: what you follow is a vector query (Phase 8)

A topic is a sentence the reader writes, embedded **once**, matched against the shared pool
by cosine similarity. One embed call per topic _ever_ and zero per digest, so the cost model
holds — the marginal cost of a twentieth interest is still nothing. It also turns a
documented wart into the design: once retrieval is a vector query, "a category's pool can
contain articles that arrived via another category's feeds" stops being a leak.

Topics **union** with categories rather than replacing them, so an account with no topics
gets exactly the digest it got before.

- `topics` has **no insert policy**. Creating one means embedding its label, the browser
  never calls Gemini, and a row without a vector silently matches nothing — so inserts go
  through the `topics` function on the service role.
- Updates are narrowed by **column grant** to `enabled` and `weight`, the same way
  news_items grants only `is_saved`/`read_at`. Editing a label would have to re-embed, so it
  is a delete and re-add.
- The **preview** is the point of the UI, not decoration: a topic is a guess until you see it
  hit something, and an interest we have no feeds for should announce itself rather than
  contributing nothing to every digest forever. It reports `covered` and the best similarity
  even when nothing clears the floor.

### Feature switches (Phase 8)

`user_features` + `_shared/features.ts`. The gate is read at **each function's entry point
through one helper**, for the same reason quiet hours live inside `notify.ts`: it is a
property of the user, and forgetting it once is the bug that messages someone who switched
it off. A toggle that only hides a nav item is decoration.

- **An absent row means the default**, so adding a feature needs no backfill and a failed
  read falls back to the default — "it works" rather than "it stopped for everyone".
- **`planner` is the only feature defaulting off.** A cron job that messages you at 9am is
  something you agree to, not something you discover.
- `filterEnabled()` narrows a list of ids in one query, because the cron functions iterate
  users and a round trip each is exactly the per-user cost the pipeline avoids.
- The browser's copy (`FEATURES`/`featureDefault` in `src/lib/queries.ts`) and the Edge copy
  are a **fourth mirrored pair** — see the drift note below. There is a parity test.
