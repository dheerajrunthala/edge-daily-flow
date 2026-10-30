---
name: ship-change
description: The end-to-end loop for landing one change in Daily Edge — the mirrored-pair check, the local gates, which functions to redeploy when a shared module changes, verifying through the production path, and the house commit style. Use for every block of work, after the code is written and before it is committed.
---

# Shipping one change

The loop, in order. Each step is here because skipping it has produced a bug that reached
production.

## 1. Pull

```bash
git pull --ff-only
```

Lovable pushes to this branch without warning.

## 2. If you touched one side of a mirrored pair, check the other

Three pairs are deliberately duplicated, because the browser and the Deno runtime cannot
import from each other:

- `src/lib/tz.ts` ↔ `supabase/functions/_shared/time.ts`
- `src/lib/task-logic.ts` ↔ `_shared/tasks.ts`
- `src/lib/queries.ts` (`FEATURES`, `featureDefault`) ↔ `_shared/features.ts`

Run the **`mirror-drift-checker`** subagent, or read both files and compare _behaviour on the
same input_ — not text. The canonical failure was a one-word signature difference
(`Date | string` versus `Date`) that broke completing any birthday from Telegram.

## 3. Format, then run the gates

```bash
npx prettier --write <the files you touched>
npm run lint && npm test && npm run build
```

All three, every time. `lint` must report **0 errors** (12 pre-existing warnings in
`components/ui/*` are shadcn's and are expected). The PostToolUse hook already runs lint and
tests after each edit, but it never blocks — these are the gate.

## 4. Deploy every function that bundles a changed shared module

> The full deploy detail — retry loop, `config.toml` reasoning, and how to read a silent
> failure — lives in the **`deploy-and-verify-fn`** skill. What follows is the part you must
> not get wrong even if you never open it.

Not only the one you edited:

```bash
git grep -l 'shared/<changed-file>' supabase/functions
```

A shared fix that reaches one function is exactly how the `dayKey` bug survived in half the
project. Then:

```bash
set -a; . ./.env.local; set +a    # SUPABASE_ACCESS_TOKEN, gitignored by *.local
npx --yes supabase@latest functions deploy <name> --project-ref uhhphhkpxxofspbfynmo
```

Two things to expect:

- **The jsr flake.** `Failed to bundle … jsr.io/… timed out after 10s` is Supabase's bundler,
  not your code — jsr.io answers in well under a second from here. Retry; it usually lands
  within three attempts, and the big bundles (`mcp`) flake most.
- **`config.toml` must list the function.** An unlisted function defaults to
  `verify_jwt = true`. For anything authenticated by something other than a Supabase JWT, that
  rejects every real caller _before the handler runs_. `push-action` was one deploy away from
  this: it is reached from the service worker, which has no session at all.

## 5. Verify through the production path

> Test strategy as a whole — the six tiers, what is testable under vitest, how to test model
> output — is the **`write-tests`** skill. This step is only about proving _this_ change ran.

Never invent a test path. Use the one cron uses:

```sql
select public.invoke_edge_function('<name>', '{"force": true}');
```

Then read the outcome from `net._http_response` for the returned id:

| what you see                | what it means                                                            |
| --------------------------- | ------------------------------------------------------------------------ |
| `BOOT_ERROR`                | a bad import — a missing export is a boot failure here, not a type error |
| `IDLE_TIMEOUT` (150s)       | something hung; nothing that was going to be logged ever was             |
| `401`                       | check `config.toml`                                                      |
| `200` with an `error` field | the handler's own refusal; the message is written for a human            |
| null row                    | still in flight — conclude nothing                                       |

Read logs with **`event_message`**, the top-level column. `log_attributes['event_message']`
returns empty strings, which looks exactly like a function that logged nothing. And run
`select now()` before choosing a window — one guessed from local time is hours off and returns
nothing, which also looks like silence.

**Then read back the rows.** A 200 is not success: `plan-day` once returned 200 having done
nothing, and only `ai_events` and `mcp_tool_calls` showed it. Use **`edge-fn-verifier`** for
this if the change is non-trivial.

## 6. Commit in the house style

A prose-imperative subject and a body that explains **why** — the tradeoff, the alternative
that was rejected, the production fact that forced it. Not Conventional Commits.

These bodies are the only durable record of why a threshold is 0.90 and not 0.85, so they are
worth writing properly the first time. Good examples in the log:

- `Make the embeddings readable: vector search and follow-up linking`
- `Pin verify_jwt for the push functions before a CLI deploy breaks them`

End with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Rules: one commit per coherent change; **never rewrite published history** (no force push, no
rebase or amend of pushed commits — it rewrites history on Lovable's side and the owner loses
their project history); never leave the tree dirty between steps.

## 7. Push

```bash
git push
```

So the remote always reflects a working state, and so a stopped session leaves something
coherent behind.

## 8. Update the prose if the change made it wrong

If the change contradicts `CLAUDE.md` — a corrected threshold, a new table, a closed gap —
fix it in the same session. That file went stale inside a single day once: it still specified a
threshold the code had corrected and still listed a shipped feature as unbuilt. It is the thing
that makes the next session possible, so it is part of the change, not paperwork after it.
