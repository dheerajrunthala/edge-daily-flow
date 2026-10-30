# Decisions worth not relitigating

Each of these was argued once and settled. If you are about to change one, the burden is to
beat the reason, not to restate the alternative.

Measured constants are in their own section at the end — those are not opinions.

---

## Architecture

**Never run the full Gemini pipeline per user.** For every category any enabled user follows,
articles are fetched, summarised and embedded **once** into a shared `articles` pool. A digest
is then one Gemini call ranking that pool for one reader. The marginal cost of a user is one
Flash call a day. Everything in the news design serves this, including topics being a vector
query over the existing pool rather than new feeds.

**The MCP server does no parsing; the agent does all of it.** Opposite answers to the same
question, for one reason: an MCP client is _already_ a model holding the conversation, the repo
and the diff, so it resolves "tomorrow morning" better than a second model reading one bare
sentence. The `agent` function's caller is a person typing, so the thinking has to happen
server-side. They share every layer underneath — the ownership guard, the date coercion, the
task shape — so they differ in who thinks, not in what is true.

**Interfaces separate, logic shared.** `_shared/agent-tools.ts` owns the ownership guard and
every value coercion; the MCP zod schemas and the Gemini function declarations stay separate,
because they are genuinely different interfaces. The 13 MCP handler _bodies_ were deliberately
**not** moved — 940 lines of production-verified registration is a large change for an
architectural tidy, while the parts that drift _dangerously_ are the ones that moved. Two
copies of `parseInstant` would silently book 2:30pm for an Asia/Kolkata user who said 9am.

**`Ctx` carries no credential.** The MCP server extends it with an API token; the chat agent
resolves the same shape from a session JWT; the planner builds it from a user id on a cron
tick. A tool body cannot tell them apart, which is the point — one that could would eventually
behave differently.

**Permissions by construction, not by prompt.** A prompt is a request; an allowlist is a rule.
Four surfaces get four tool sets, and the cron planner gets no write tools at all. `delete_task`
is absent from all four — the MCP server has it because a developer's editor can confirm first,
and "delete the thing about the client" said to a speaker is not a confirmation.

**Fan out rather than loop.** `fanout_ingest_news()` and `fanout_build_digests()` each do one
`net.http_post` per unit of work so every unit gets its own 150s budget. Deliberately two
near-identical loops rather than one abstraction: two short functions that read plainly beat
one parameterised helper nobody can follow.

---

## Correctness

**The model never supplies a URL.** `build-digests` has Gemini return _indices_ into the
candidate list; headlines and links are copied from `articles`. There is no hallucinated link
to validate because there is no field to put one in. The agent extends the same idea: an
answer's links are checked against what its tools actually returned, and anything else is
reported as unverified rather than silently stripped — a fabricated link is worse than a wrong
summary, because the summary is visibly an opinion and a URL looks like a fact.

**`due_at` without a UTC offset is rejected, not assumed.** `new Date("2026-10-13T09:00:00")`
reads as local-to-the-server, which for an Asia/Kolkata user silently books 2:30pm. A loud
error the model can act on beats a reminder the user quietly stops trusting.

**An `all_day` task's `due_at` is snapped to local midnight** server-side rather than refused.
The reminder ladder reads it to decide an all-day task gets only a lead reminder, and a
birthday with an 09:00 `due_at` would nag from 9am.

**Unknown tag names are created, matched case-insensitively.** `tasks.tags` is a `text[]` with
no FK, so an unknown name is not an error — it just renders uncoloured and never appears in the
tag filter. Creating the row is what makes an agent-invented tag usable afterwards. The
consequence, stated in the MCP instructions: a typo becomes a permanent tag.

**`list_tasks` groups in TypeScript, not SQL.** Comparison is by _day_ in the user's timezone,
so a task due later today is "today" and an all-day task due today is never overdue. A
`due_at < now()` query gets both wrong, and a filter that disagreed with the `/tasks` page
would be worse than no filter.

**`search` is sanitised** of `,()\%_` before reaching a PostgREST `or=(...)` filter, where
those characters are syntax: "fix(auth), part 2" would otherwise parse as extra clauses.

**Rescheduling deletes the old occurrence's ledger rows.** Without that, rescheduling _back_ to
an already-notified time would find every stage claimed and send nothing at all.

---

## Reliability

**Claim before you spend, release on failure.** `brief_sends`, `task_notifications` and
`plan_sends` are all claimed _before_ the expensive call and deleted again if it fails. That is
what makes overlapping cron ticks unable to double-send, and what stops one SMTP hiccup from
marking a day done and silently delivering nothing.

**A hang is different information from a 503.** A 503 means "busy, retry shortly"; a hang means
the request went in and nothing came back. So a timeout **abandons that model immediately**
rather than spending four more attempts rediscovering it — which is what leaves budget to try
the fallback, the thing that actually worked.

**Believe the API over your own backoff.** A quota 429 carries the wait in
`RetryInfo.retryDelay` and in prose. Exponential backoff cannot fix a per-minute quota: 15
seconds of patience for a window that resets in 60. `retryAfterMs()` honours what the API says,
capped at 55s.

**Every network call carries its own deadline.** An unbounded `fetch` inside a 150s runtime is
not a long wait, it is a lost error — the platform kills the isolate and nothing that was going
to be logged ever is.

**Model ids are env-overridable, never hard-pinned in source.** A pinned id that does not exist
fails every call with a 404 — a total, silent outage — and the id cannot be verified from a
development environment because the key lives only in the platform's secret store. The owner
pins with `supabase secrets set` after checking ListModels; a bad value is one secret away from
reverting.

**A repair job must not cause the damage it repairs.** The embedding repair runs at
`:07/:17/:27/…` and shares a minute with no other job. `*/10` would have fired at 01:00 UTC
alongside six parallel ingest invocations all embedding, and the articles that lost the quota
race would have been _fresh_ ones — pooled vectorless and therefore permanent.

---

## Rejected

**Arbitrary user-supplied RSS URLs.** Per-user ingest cost plus an SSRF surface, and it breaks
the shared-pool economics. Topics as vector queries give the same user-facing capability for
one embed call per topic, ever.

**A session id on the MCP server.** Edge invocations are ephemeral and a later request may land
in a different isolate, so a session would resolve to "session not found" as soon as one
recycled. The bearer token carries all the identity a tool call needs.

**A generated service worker.** `vite-plugin-pwa` emits to `dist/service-worker.js`, which the
nitro build never copies into `.output/public/` — it would 404 in production. There is also
nothing to precache (the app is SSR) and nothing to inject: every push payload already carries
the URL to open and the URL to post a button press to.

**A third notification action button.** Chrome renders at most two and silently drops the rest,
so "Tomorrow" stays a Telegram and in-app affordance.

**An in-function reconciler for stuck digests.** The retry is a property of the _schedule_, not
of the function. Expressing it as a second cron entry means there is no new branch to get
wrong, and it costs nothing for a digest already `ready`.

---

## Measured constants

These were not chosen. Two of them were wrong when first intuited, which is why the rule exists.

| constant                   | value                              | how it was found                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| follow-up similarity       | **0.90**                           | 0.85 was the _median_ nearest cross-digest neighbour over 316 items, so it badged 157 of 316 — half the feed. Reading pairs by band: 0.82–0.89 is "same category, unrelated story", 0.90+ is one thread. Keeps ~11%.                                                               |
| topic match floor          | **0.80**                           | 0.60 matched the entire archive. `gemini-embedding-001` at 768 dims compresses everything into 0.75–0.88. Over seven probe labels, covered topics peaked 0.8401–0.8758 and uncovered ones 0.7735–0.7906. 0.80 sits in the gap. 0.82 cut a well-covered topic from 12 matches to 3. |
| duplicate headline overlap | **0.45** Jaccard                   | Swept a live 585-item pull and read every pair: 0.45–0.55 was entirely true duplicates, 0.35–0.45 began mixing genuinely different stories.                                                                                                                                        |
| embed repair batch         | **90**                             | Sized to the quota, not the wall clock: the free tier allows 100 `embed_content` requests/minute and `batchEmbedContents` counts each _text_. A run asked to repair 200 repaired exactly 100.                                                                                      |
| recency window             | **72h** primary, **24h** otherwise | Lab blogs and GitHub release feeds are quiet for days; a 24h window dropped the primary tier entirely most days.                                                                                                                                                                   |
| candidate cap              | **40**/category                    | The pool is ~600 items a day; summarising all of it would be most of the product's cost for no benefit.                                                                                                                                                                            |

**The rule:** run the distribution, read the actual pairs by band — counts alone will mislead
you — then put the numbers in the migration comment so nobody re-derives them.
