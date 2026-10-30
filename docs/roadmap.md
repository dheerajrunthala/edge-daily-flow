# Roadmap

What is built, what is verified, and — the part that matters — **what is not yet exercised**.

Every phase entry names its own unverified paths on purpose, so "deployed" is never mistaken for "working".

### Roadmap

- [ ] Phase 1: review Lovable draft against schema; fix data wiring, recurrence roll-forward, types
- [ ] Phase 2: `parse-task` + quick-add preview, rate limiting
- [x] Phase 3: `articles` pool migration, `ingest-news`, `build-digests`, `url_resolved` +
      "via Google News" tag in the news card. Both functions are deployed and have been run
      end to end; **cron is not wired yet** (that migration is Phase 4).
- [x] Phase 4: `send-briefs` + `check-reminders` + all five cron schedules. Gmail SMTP is
      live and verified: a real brief was delivered (20 stories, 2 tasks, 5.1s), `brief_sends`
      linked it to the digest and stamped `digests.emailed_at`, and re-firing the same slot
      answered "already sent" without a second email. `check-reminders` runs clean but its
      SMTP path is still unexercised — no task has `remind_before` set yet.
- [x] Phase 5: Notifications. `notification_prefs`, `task_notifications`,
      `tasks.snoozed_until`, `telegram_links`; `_shared/notify.ts`; check-reminders reworked
      into the escalation ladder on a per-minute cron; `telegram-webhook` with linking,
      inline buttons, commands and free-text task capture; Settings UI for channels, quiet
      hours and the nag interval.
      **Verified in production 2026-10-12:** Telegram linking end to end (`chat_id` bound,
      one-time code consumed, the `telegram` channel switched on by the webhook); `lead`
      delivered to email + Telegram at 14:21:04, one tick after its fire time; `15m`
      delivered to **Telegram only** with no email row written, which is the routing rule
      holding; the Done button completing a task from the chat. **Not yet exercised:** the
      `due` and `nag:k` rungs (the test task was completed four minutes before it came
      due), `1h`, quiet-hours suppression, snooze and Tomorrow, and the free-text →
      `parse-task` path from a chat.
- [ ] Phase 6: Insights page with real data, PWA polish. **The Insights page is done** — it
      landed in Phase 9, where its verification is recorded.
      **Follow-up linking is done** —
      see Vector retrieval (Phase 8); the threshold it specified turned out to be the median.
      **Browser notifications are done** (2026-10-12): in-app realtime toast + chime +
      tab/favicon badge, `push_subscriptions`, `public/sw.js`, `push-subscribe`,
      `push-action`, the `push` sender in `notify.ts`, and the Settings card with
      enable/test and the macOS "Alerts" hint. Verified: both functions boot in the Edge
      runtime (so `jsr:@negrel/webpush` resolves), `push-action` rejects an unsigned
      token, and check-reminders still returns 200 on the new module graph.
      **Not yet exercised:** a real end-to-end push to a granted browser, the Done /
      Snooze buttons from a notification, and expiry pruning on 404/410.
- [x] Phase 7: **MCP server.** `api_tokens` + `create_api_token()`, `mcp_tool_calls`,
      `notification_prefs.morning_time`, `tasks.source = 'mcp'`; the `mcp` Edge Function with
      13 tools; Settings → Integrations. **Verified in production 2026-10-12** against two
      throwaway accounts: all 13 tools over HTTP, a full handshake with the official SDK
      client (instructions delivered, 13 tools listed, create → delete round trip), every
      validation rejection, the 120/hour rate limit returning 429, token revocation, and
      **cross-user isolation** — token B could not read, update, complete, snooze, delete or
      save any of user A's tasks or news items, and A's rows were untouched afterwards.
      **Not yet exercised:** a real Claude Code session from a repo (the owner connects their
      own token), and Claude Desktop via `mcp-remote`.
- [x] Phase 8: **the agent layer.** Vector retrieval (`match_news_items`, `match_articles`,
      `match_topics_pool`, `link_followups` + HNSW indexes), topics as vector queries, the
      shared tool registry, `generateWithTools`, the `agent` function and `/ask` with
      dictation, feature switches, and the `plan-day` autonomous planner.
      **Verified in production 2026-10-28:** the refactored MCP server byte-identical to its
      pre-refactor output across get_context / list_tasks / search / create → delete, with
      `parseInstant` still rejecting an offset-less `due_at` and "coding" still folding into
      "Coding"; follow-up linking backfilled 14 correct links over 30 digests, every one
      pointing earlier (the Jio IPO thread came out as Oct 15 → 18 → 25); `build-digests`
      rebuilt a `ready` digest with 20 items from 105 candidates; `plan-day` called three
      tools in one turn, fell through to the fallback model, and delivered on email +
      telegram + push; and the feature gate held — the run before the `planner` row existed
      spent nothing and said "no users due for a plan".
      **Also fixed, found while building:** three days of missing digests (a leftover QA
      account starving the invocation plus a retry policy that was a formality), and a
      host-timezone bug in `parseFeedDate`.
      **Not yet exercised:** the `agent` function's happy path from a browser session (a user
      JWT cannot be minted from a Claude Code session — the owner must try `/ask`), dictation
      on a real microphone, and the `telegram` surface of the registry. The `voice` surface was
      exercised in Phase 10.
- [ ] Phase 9: **submission hardening.** Delivers: the process layer as committed skills
      (`start-phase`, `write-tests`, `ship-change`), `fanout_build_digests()` so one slow user
      cannot starve the rest, a reconciler for digests left `pending` by a killed isolate, an
      embedding repair pass, pinned Gemini model versions, the manual verification of Phase 8
      codified as runnable scripts, a real Insights page, an `.ics` "add to calendar" export,
      and the submission documents under `docs/`.
      **Exit criteria:** `npm run build && lint && test` green; `scripts/db-checks.sql` passes;
      every Edge Function boots; a `ready` digest produced through `fanout_build_digests()`;
      `count(*) where embedding is null` falling.
      **Found on entry:** the embedding gap had _widened_ since Phase 8 (797 of 2,651 missing,
      oldest 2026-10-13) because `_shared/gemini.ts` changed but only five of the **seven**
      functions bundling it were redeployed — `ingest-news`, `parse-task` and
      `telegram-webhook` were still running the three-attempt retry with no fallback. Exactly
      the rule `ship-change` step 4 exists to enforce, missed in the session that wrote it.
      Chasing it then found the actual cause, which was never capacity: the free tier caps
      `embed_content` at **100 requests/minute** and `batchEmbedContents` counts each text,
      so no retry policy could have fixed it. Also found: `plan-day` had no cron row at all,
      and three `pending` digests were unreachable by any future run.
      **Closed, measured 2026-10-30:** `select count(*) from articles where embedding is null`
      is now **0** of 2,651, down from the 797 found on entry. The `repair-embeddings` job at
      :07 past the hour drained the backlog without ever competing with the 01:00 ingest
      fan-out for the same 100-requests-per-minute quota, which was the whole point of the
      odd offset.
      **Insights is done (2026-10-30).** `MIN_PER_ARTICLE = 3` is deleted — the page had been
      multiplying articles scanned by an invented three minutes and calling it "reading time
      saved". What replaced it reads the tables Phase 8 filled and nothing else: four tiles
      (articles scanned, stories opened of delivered, follow-ups linked, on-time completion), a
      stacked `mcp_tool_calls`-by-`surface` chart, tasks by creation path, and model spend by
      `ai_events.kind`. Aggregation is pure in `src/lib/insights.ts` with 21 unit tests.
      **Verified:** every figure the page computes was asserted against the same aggregate run
      in SQL through the MCP for the owner's account over 2026-10-01…30 — scanned 1,689, opened
      7 of 320 (2%), 10 follow-ups, on-time 4/49 (8%), 84 tool calls (81 mcp / 3 planner, 1
      failed), tasks 6 manual / 3 ai / 37 mcp / 1 telegram, 224,433 tokens (digest 209,096 ·
      plan 10,169 · task_parse 5,168), 50 completions. The hooks' row sets were read back
      through the real `authenticated` role with the owner's JWT claims, which also confirmed
      the 88 `ai_events` rows with a null `user_id` are invisible to a browser. **Not yet
      exercised:** the rendered page in a browser — Chrome returned "frame is showing error
      page" for every localhost URL this session, so the layout, the dark-mode pass and the
      empty state for a new account have not been _looked_ at (**owner-assigned**).
      **Deliberately skipped:** topic coverage — no row records whether an item arrived via a
      topic; see Rejected in `docs/decisions.md`.
      **Will remain unverified:** the `agent` happy path from a browser session (a user JWT
      cannot be minted outside one — **owner-assigned**), dictation on a real microphone, the
      `telegram` registry surface, and the web-push action buttons. The `voice` surface came
      off this list in Phase 10 — `mcp_tool_calls` holds 8 rows at `surface = 'voice'`, 0
      failed — though from the skill's own invocations, not from a real Echo.
- [x] Phase 10: **the voice door.** `alexa-skill` on the existing `voice` surface, plus
      `/authorize` for OAuth2 **implicit-grant** account linking. Implicit rather than
      authorization-code because the credential it returns is already long-lived and
      revocable — an ordinary `de_` row in `api_tokens` — so there is no token endpoint, no
      refresh flow and no second credential system. Revoking the "Alexa" token in Settings →
      Integrations stops the skill immediately.
      One free-text `AskIntent` funnels into the agent rather than ten brittle slot intents,
      because the agent is better at working out what was meant than a slot grammar is.
      **Verified in production:** no access token returns a LinkAccount card rather than an
      error; a stale timestamp is refused; an unknown `de_` token prompts re-linking rather
      than 500-ing. The `redirect_uri` allowlist is checked on host _and_ path — an authorize
      endpoint that reflects an arbitrary redirect is an open redirector handing out live API
      tokens.
      **Known gap, deliberate:** Amazon's certificate-chain signature verification is **not**
      implemented. Only `applicationId` and request freshness are checked. What actually gates
      access is the account-linking token, which an attacker does not have; the signature
      proves the request came from Amazon, which matters less given that. Worth closing before
      certification.
      **Not yet exercised:** the skill from a real Echo device, and the linking flow end to end
      through the Alexa app — both need the Amazon developer console, which is owner-assigned.
- [x] Phase 11: **the claims harness.** `npm run verify` (`scripts/verify-claims.sh` plus
      `scripts/verify/live-sql.mjs`): fourteen claims in one command, grouped by what each
      needs, printed as a PASS/FAIL table with the real number beside it. It replaces the SQL
      the README used to ask a reader to paste by hand, and it makes `scripts/db-checks.sql`
      runnable from a shell rather than only from an agent session — through
      `POST /v1/projects/{ref}/database/query`, the endpoint the hosted Supabase MCP server
      calls underneath `execute_sql`. Also three skills for procedures that had become tacit
      (`verify-production`, `debug-silent-failure`, `add-voice-surface`) and two subagents for
      jobs that were being done by hand (`test-writer` on sonnet, `latency-auditor` on haiku).
      **Verified 2026-10-30:** 13 passed, 1 skipped — 240 tests across 13 files, 0 lint
      errors, 13/13 of the destructive-SQL hook's cases in both directions, 8 agents each with
      an explicit model and none on opus, 13/13 Edge Functions booting and reaching their
      handler (the thirteenth probe, `alexa-skill`, is new), all 13 database assertions
      silent, 0 of account A's rows leaked when asking `match_news_items` as account B, 92
      tool calls across 3 surfaces with 1 failure, and 15 follow-up links across 12 digests.
      The one skip is the cross-account isolation suite, which needs two accounts' `de_`
      tokens and stays **owner-assigned**; it prints what it needed rather than passing.
      **Found while building it:** three of the harness's own claim queries read the wrong
      value, because the Management API keys rows by column name — two columns both called
      `count` collapsed in `JSON.parse` and the row came back a field short with a plausible
      number sitting in the wrong place. Also: code is deliberately duplicated in **five**
      places and CLAUDE.md rule 5 listed three, with the ordinals in two test-file comments
      disagreeing with each other.
      **Known drift, not fixed:** `supabase_migrations.schema_migrations` holds 22 rows while
      the repo holds 20 files, and three names do not line up — the repo has
      `fanout_build_digests` where the database has `fanout_build_digests_and_schedules`, and
      the database has `topics_measured_threshold` and `vector_retrieval_followup_threshold`
      with no file of either name. The schemas agree; the bookkeeping does not. Reconciling it
      means renaming already-applied migrations, so it is **owner-assigned**.
      **Not yet exercised:** `test-writer` and `latency-auditor` have not been invoked in
      anger, and `npm run verify` has only ever run on one machine — `--local` is the path
      that is portable by construction.
- [ ] Phase 12 (optional): Google Calendar two-way sync so the planner can see when you are
      free, WhatsApp, the weekly review email, Telegram free text through the agent, and
      Playwright E2E. ChatGPT as an MCP client is now closer too: `/authorize` exists, and
      wiring it to the `mcp` function is a small step from here.
