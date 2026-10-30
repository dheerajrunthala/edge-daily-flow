---
name: verify-production
description: Prove a change actually ran against the live project — invoke through the production path, read net._http_response, decode BOOT_ERROR and IDLE_TIMEOUT, read the logs with the right field, then read the rows back. Use after any deploy, after any cron or Edge Function change, and whenever something returned 200 and you have not yet seen the row it was supposed to write.
---

# Verifying in production

**A 200 is not success.** `plan-day` once returned 200 having done nothing at all; the only
things that showed it were `ai_events` and `mcp_tool_calls`. This is the loop that catches
that, in order. Skipping step 5 is how a change gets called done.

Do not invent a verification path. Every step below uses the path production uses.

---

## 0. Ask the database what time it is

```sql
select now();
```

First, before anything else. Every log query below takes a window, and a window picked from
your laptop's clock is hours off in a UTC runtime — it returns no rows, which is
indistinguishable from a function that logged nothing. This one line has cost hours twice.

---

## 1. Invoke through the production path

| the function is…                                                                           | invoke it with                                                            | notes                                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| cron-secret (`ingest-news`, `build-digests`, `send-briefs`, `check-reminders`, `plan-day`) | `select public.invoke_edge_function('<name>', '{"force": true}');`        | exactly what `cron.job` runs; reads `project_url` and `cron_secret` out of Vault, so no secret is inlined     |
| a user-JWT function (`parse-task`, `agent`, `topics`, `push-subscribe`)                    | you cannot — the service role key lives only in the platform secret store | verify the refusals you _can_ reach, and hand the happy path to the owner. Say so; do not imply you tested it |
| an MCP tool                                                                                | call it through the connected `daily-edge` MCP server                     | and diff the output against what it returned before the change                                                |
| a webhook / voice door (`telegram-webhook`, `push-action`, `alexa-skill`)                  | `POST` with the credential shape the real caller sends                    | `npm run test:contract` already probes each one's refusal                                                     |

The SQL form returns a pg_net request id. Keep it.

**Do not invoke `ingest-news` or `build-digests` casually.** They spend Gemini quota —
ingest embeds, and build-digests is one call per user. If you only need to know the bundle
is healthy, `npm run test:contract` boots every isolate with a deliberately wrong secret
and writes nothing.

---

## 2. Read the outcome out of pg_net

```sql
select status_code, error_msg, left(coalesce(content, '(in flight)'), 2000) as body
from net._http_response where id = <the id from step 1>;
```

| what you see                                    | what it means                                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **no row at all**                               | still in flight. **Conclude nothing.** Wait and re-read                                                                                                              |
| `BOOT_ERROR`, or 503 "Function failed to start" | a bad import. Almost always `import { X }` from a module that does not export `X` — here that is a _boot failure_, not a type error, and the function logs are empty |
| `IDLE_TIMEOUT`, or 504 "(150s) reached"         | something hung. The isolate was killed, so nothing that was going to be logged ever was. Look for a `fetch` with no deadline                                         |
| `401`                                           | check `supabase/config.toml`. An unlisted function defaults to `verify_jwt = true` and the gateway rejects cron and webhook callers _before the handler runs_        |
| `200` with an `error` field in the body         | the handler's own refusal. The message is written for a human — read it rather than guessing                                                                         |
| `200` with the shape you expected               | you have learned that the handler returned. **Nothing more.** Go to step 5                                                                                           |

---

## 3. Read the logs with the right field name

```sql
select timestamp, event_message from logs
where source = 'function_logs'
order by timestamp desc limit 30
```

`event_message` is a **top-level column**. `log_attributes['event_message']` returns empty
strings, which looks exactly like a function that logged nothing — and that is the single
most time-wasting trap in this project. Bound the window with
`iso_timestamp_start` / `iso_timestamp_end` around the invocation from step 0's `now()`.

---

## 4. If the invocation is not in the logs at all, you are debugging silence

Stop verifying and load the **`debug-silent-failure`** skill. It is the decision tree for
"it did nothing and logged nothing", which has at least nine distinct causes here and only
one of them is in your code.

---

## 5. Read the rows back

This is the step that exists because step 2 lies. Each function's proof is a specific row,
not a status code:

| function                                     | the rows that prove it ran                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest-news`                                | `articles` count rose; `count(*) where embedding is null` did **not** rise; an `ai_events` row of kind `summary`/`embedding`                  |
| `build-digests`                              | `digests.status = 'ready'` with a sane `items_count`, and that many `news_items` rows pointing at it; one `ai_events` row of kind `digest`    |
| `send-briefs`                                | a `brief_sends` row for the slot **and** `digests.emailed_at` stamped. Re-fire the same slot: it must answer "already sent" and write nothing |
| `check-reminders`                            | `task_notifications` claimed for the expected stage, per channel, and `tasks.last_reminded_at` moved                                          |
| `plan-day`                                   | an `ai_events` row of kind `plan`, `mcp_tool_calls` rows with `surface = 'planner'`, and a `plan_sends` row                                   |
| `agent` / `alexa-skill` / `telegram-webhook` | `mcp_tool_calls` with the right `surface` — it is the only record of what the model actually did                                              |
| `topics`                                     | the `topics` row exists **and** its `embedding` is not null                                                                                   |
| anything that writes a task                  | the `tasks` row, with `source` set to the door it came from                                                                                   |

From a shell, without a session:

```bash
node scripts/verify/live-sql.mjs --sql "select status, items_count from digests order by created_at desc limit 3"
```

**Alias every column.** The API answers with JSON objects keyed by column name, so
`select count(*), count(distinct x)` names both columns `count` and only the last survives
`JSON.parse` — the row comes back a field short with a plausible number in the wrong place.

---

## 6. Check the negative evidence too

A test that only asserts the good thing happened passes for an implementation that also did
a bad thing.

- after a create → delete round trip, query for leftovers
- after an isolation check, re-read the **other** account's rows and compare them to the
  snapshot you took first. "Token B got an error" is half a test; an implementation that
  refuses the read and performs the write anyway passes it
- after a feature-gate run, confirm the gate spent **nothing** — no `ai_events` row, not
  just no delivery
- after a quiet-hours run, confirm no `task_notifications` claim was taken, because a claim
  taken and then suppressed is a reminder the user will never get

---

## 7. Say what you did not verify

Name it explicitly rather than letting the reader assume the whole path is covered. The
standing examples, which are **owner-assigned** and must not be claimed:

- the `agent` happy path from a browser session — no user JWT can be minted here
- a real Echo device, and the Alexa linking flow through the Amazon console
- dictation on a real microphone
- a real end-to-end web push to a granted browser

These live in [docs/roadmap.md](../../../docs/roadmap.md) under each phase's "Not yet
exercised". If you close one, move it; if you find a new one, add it.

---

## The shortcut

`npm run verify` runs the parts of this loop that are already codified — the 13 database
assertions, the 13 boot probes, the cross-account leak query, the audit trail — and prints
PASS/FAIL per claim. It never reports a check it could not run as a pass. Use it as the
floor, not as a substitute for reading back the rows of the thing _you_ just changed.

For a non-trivial change, hand step 1–5 to the **`edge-fn-verifier`** subagent: the whole
decision table above is written into its prompt, which is why it runs on haiku.
