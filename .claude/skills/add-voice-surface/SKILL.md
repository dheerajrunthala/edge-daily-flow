---
name: add-voice-surface
description: Add a new front door to the Daily Edge agent — a voice assistant, a new chat client, a watch app, anything that reaches the shared tool registry. Covers the surface allowlist, the audit column's check constraint, the per-surface latency budget, the feature gate and the boot probe. Alexa's eight-second ceiling is the worked example. Use when adding or changing any caller of _shared/agent-registry.ts.
---

# Adding a front door

The agent has five doors — chat, Telegram, the MCP server, the cron planner and Alexa — and
they all run the same handlers in `_shared/agent-registry.ts`. That is the point: "tomorrow
9am" and "which rows may I touch" are answered in one place for every caller.

A new door is therefore **not** new agent logic. It is nine specific edits, and the two
that are easy to miss both fail silently.

---

## The two questions that decide everything else

**1. What can this door show back, and who is present?**

That answers the allowlist. It is not a preference:

| door       | may create | may complete | why                                                                                                |
| ---------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `chat`     | yes        | yes          | shows exactly what was done, and offers an undo                                                    |
| `telegram` | yes        | yes          | same — the message stays in the thread                                                             |
| `voice`    | yes        | **no**       | it may have misheard and shows nothing back. It may add to the list; it may not tick things off it |
| `planner`  | **no**     | **no**       | runs on cron with nobody present to notice a mistake                                               |

`delete_task` is absent from every one of them. The MCP server has it because a developer's
editor can confirm first; "delete the thing about the client" said out loud to a speaker is
not a confirmation.

**2. How long will the caller wait?**

That answers the latency budget, and it changes which answers are even reachable. See
[Budget](#3-size-the-latency-budget-to-the-door-not-to-the-model) — this is the part that
cannot be fixed later by prompting.

---

## 1. The surface allowlist

`supabase/functions/_shared/agent-registry.ts`:

```ts
export type Surface = "chat" | "voice" | "telegram" | "planner";   // add yours

export const SURFACE_TOOLS: Record<Surface, readonly string[]> = {
  …
  <yours>: ["search_news", "my_news", "list_tasks", "get_brief"],  // the narrowest set that works
};
```

The allowlist is enforced **twice**, and keep it that way: `declarationsFor(surface)`
decides what the model can see, and `runTool()` checks again before dispatch. A model that
hallucinates a tool name it was never given would otherwise land in the dispatcher's default
branch, and `runTool` is the layer holding the user's id.

Add a case to `_shared/agent-registry.test.ts` asserting the door **cannot** reach what it
must not — through `runTool`, not merely by being absent from the declaration list. The
existing `withholds every mutating tool but create_task from voice` test is the template.

## 2. The audit column — and its check constraint

Every tool call writes a row through `logToolCall()` into `mcp_tool_calls`, with `surface`.
That table is the only record of what a model actually did, and the Insights page reads it.

**`mcp_tool_calls.surface` has a CHECK constraint**, and a new value is not in it:

```sql
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.mcp_tool_calls'::regclass and conname = 'mcp_tool_calls_surface_check';
-- CHECK (surface = ANY (ARRAY['mcp','chat','voice','telegram','planner']))
```

So a new surface **needs a migration widening it** — and this is the first failure that is
silent. `logToolCall()` ends with:

```ts
if (error) console.error("mcp_tool_calls insert failed", error.message);
```

It does not throw. The tool call succeeds, the user gets their answer, and the audit row is
dropped with one line in the function logs. The product looks perfect and the trail is gone.

Load the **`add-migration`** skill for the migration itself. The same question applies to
two sibling constraints if the door writes through them:

- `tasks.source` — `manual | ai | mcp | telegram | agent`
- `ai_events.kind` — `task_parse | digest | summary | embedding | brief | agent | plan`

Both have rejected a value that seemed obvious: `tasks.source` refused `'agent'` and
`ai_events.kind` refused `'plan'` until each was widened. **Check the constraint before you
assume.**

Also widen `ToolSurface` in `_shared/api-tokens.ts`. It is a separate union from `Surface`
because it includes `mcp`, which is not an agent surface — so adding to one does not add to
the other, and TypeScript will tell you about exactly one of them.

## 3. Size the latency budget to the door, not to the model

The numbers in the codebase, all measured:

|                             | per-call deadline                                      | max turns                 | model                                | why                                                                                                |
| --------------------------- | ------------------------------------------------------ | ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| platform ceiling            | —                                                      | —                         | —                                    | 150s wall clock. Past it the isolate is killed and **nothing that was going to be logged ever is** |
| `_shared/gemini.ts` default | 25s (`CALL_TIMEOUT_MS`), 90s total (`TOTAL_BUDGET_MS`) | 6 (`MAX_TOOL_TURNS`)      | primary, then fallback               | suits an unattended job                                                                            |
| `plan-day`                  | default                                                | 4                         | primary, then fallback               | nobody is waiting                                                                                  |
| `voice` (`alexa-skill`)     | **4s** (`VOICE_CALL_TIMEOUT_MS`)                       | **2** (`VOICE_MAX_TURNS`) | flash-lite **directly, no fallback** | Alexa's patience is ~8s                                                                            |

The worked example, and the reason this section exists. Measured on the first real Echo
session: the agent answered **correctly, in 56 seconds**, and Alexa had long since said
"there was a problem". The whole 56s was one cause — `gemini-flash-latest` timing out at its
25s deadline on every attempt before falling through to flash-lite, which then answered in
about three seconds.

So voice does not use the primary model at all. Three consequences, each of which is a
general rule for a tight door:

- **Call the fast model first, not as a fallback.** On every other surface
  primary-then-fallback is right. Here it is the difference between an answer and a failure.
- **No retry.** There is no time for a second attempt, so `fallbackModel: null`. A retry
  that lands after the caller hung up spends quota to produce nothing.
- **Cut the turn cap to what fits.** Two turns: one to pick a tool, one to speak the
  result. A third cannot finish before the device gives up, so allowing it only burns the
  user's daily quota on an answer nobody hears.

And the cheap trick worth copying: a **fast path** that answers the common asks without a
model call at all. "What's due today" is a query and a sentence. Only what the fast path
returns `null` for reaches the agent.

Pass the budget explicitly — `callTimeoutMs` and `maxTurns` on `generateWithTools` — rather
than editing the shared defaults. The defaults are right for cron.

The measured per-tool-call cost, for sizing: `mcp` p50 **217ms** over 81 calls (max 375ms),
`voice` p50 **226ms** over 8 (max 1,058ms), `planner` p50 **148ms** over 3. The tools are
not the problem; the model call is. Re-measure with the **`latency-auditor`** subagent
rather than trusting these.

## 4. The feature gate, at the entry point

Add the door to `Feature` in `_shared/features.ts`, then call it **before spending
anything**:

```ts
if (!(await isEnabled(admin, token.userId, "<yours>"))) {
  return; /* the door's own way of saying "that's switched off" */
}
```

A gate that only hides a nav item is decoration (CLAUDE.md rule 6). A feature with no row
resolves to its default, which is **on** for everything except `planner` — add yours to
`DEFAULT_OFF` if the door starts a conversation the user did not ask for.

**Then mirror it.** `FEATURES` in `src/lib/queries.ts` is the browser's copy of that list
and the two must agree — there is a parity test pinning them, and this is one of the three
mirrored pairs in CLAUDE.md rule 5.

## 5. `config.toml`, with the reason

```toml
# <door> is called by <who>, which sends no Supabase JWT. It authenticates with <what>, so
# the platform gate would reject the only caller that is supposed to reach it.
[functions.<name>]
verify_jwt = false
```

An unlisted function defaults to `verify_jwt = true` and the **gateway** refuses before the
isolate starts — so the function looks healthy and answers nobody. `npm run verify` asserts
every function has a block.

Prefer reusing `requireApiToken()` over inventing a credential. Alexa's account linking is
OAuth2 **implicit grant** for exactly this reason: the token it hands back is an ordinary
`de_` row in `api_tokens`, already long-lived and revocable, so there is no token endpoint,
no refresh flow, and revoking it in Settings → Integrations stops the door immediately. A
second credential system is a second thing to keep in step.

## 6. A boot probe

Add one to `scripts/contract/boot-smoke.ts`. It must assert on a **handler-authored** body,
never a status code — a bare 401 can be the gateway, which means the isolate never started
and the probe proves nothing.

Pick a refusal that writes nothing. For `alexa-skill` that is an empty body: no account
token, so the handler answers with a LinkAccount card that only it can produce.

## 7. Output shape

If the door's answers need different formatting — no markdown, no URLs read aloud, two or
three sentences — branch the system prompt on `run.surface` where `voiceNote` already does
in `supabase/functions/agent/index.ts`. Do not solve it in the door's own code; the next
door with the same constraint should inherit it.

---

## Before you commit

```bash
npm run build && npm run lint && npm test
npm run verify                                   # boot probes, DB assertions, link check
git grep -l 'shared/agent-registry' supabase/functions   # every one of these needs redeploying
```

That last line is rule 3, and it is the rule most often broken: a changed shared module
reaching one function is how `dayKey()` stayed broken in half the project. Then the
**`verify-production`** skill — invoke, read `net._http_response`, and **read the
`mcp_tool_calls` rows back** with the new `surface` value in them. That row appearing is the
only proof the constraint in step 2 was actually widened.

Finally, record it: the door, its allowlist and its budget in
[docs/agent-layer.md](../../../docs/agent-layer.md), the function in
[docs/operations.md](../../../docs/operations.md), and what is **not yet exercised** in
[docs/roadmap.md](../../../docs/roadmap.md). A real device or a real client is almost always
owner-assigned — name it as such rather than letting "deployed" read as "working".
