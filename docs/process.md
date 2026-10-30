# The process layer

Everything in `.claude/` — what each piece owns, and where it was actually used. The last part
matters: a skill nobody invoked is documentation, not process.

## Why any of this exists

This project's rules were prose in `CLAUDE.md` for weeks, and **prose is a request.** Each rule
has since been moved to whichever mechanism matches how strictly it needs to hold:

| strength                    | mechanism            | example                                                                                                 |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| cannot be expressed wrongly | **the code's shape** | reads go through `mine()`, so bypassing the ownership guard requires actively writing `admin.from(...)` |
| refuses to run              | **a hook**           | `block-destructive-sql.sh` exits 2 on `DROP`                                                            |
| reviewed before it lands    | **a subagent**       | `schema-guardian` reads a migration against the live database                                           |
| loaded when it applies      | **a skill**          | `add-migration`'s five-point checklist                                                                  |
| read once per session       | **CLAUDE.md**        | the eight rules                                                                                         |

## 9 skills

Loaded on demand, so they cost nothing until the moment they apply.

| skill                  | owns                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-phase`          | How work begins: pull first, read the decisions before the code, write the roadmap entry **including what will stay unverified**, cut into independently shippable blocks, set the gates, name the human-only item.                                                                                                 |
| `ship-change`          | How one change lands: the mirrored-pair check, the three gates, deploy **every** function bundling a changed shared module, verify through the production path, commit in the house style, and fix the docs if the change made them wrong.                                                                          |
| `write-tests`          | The six tiers; the import rule that decides whether a module is testable at all; fixture discipline; how to test model output by asserting invariants rather than prose; why a threshold is measured.                                                                                                               |
| `add-migration`        | The five things every new table needs — including **column grants**, which RLS cannot express; the `extensions`-schema trap for pgvector; how to check for repo/database drift.                                                                                                                                     |
| `deploy-and-verify-fn` | The CLI loop, the jsr bundler flake and how to retry it, the `verify_jwt` default that silently rejects non-JWT callers, and the two failure modes that produce silence.                                                                                                                                            |
| `add-news-feed`        | The tier system and what it does to the ranking prompt, the `DROPPED` list _with reasons_, and the handled gotchas so they are not rediscovered.                                                                                                                                                                    |
| `verify-production`    | The read-back-the-rows loop as a procedure: `select now()` first, invoke through the production path, decode `net._http_response`, read logs with `event_message`, then **the specific row that proves each function ran** — plus the negative evidence, and what must be named owner-assigned rather than claimed. |
| `debug-silent-failure` | The decision tree for "it did nothing and logged nothing" — nine causes in cost order, each with the one query that eliminates it, ending with "only now read the logic".                                                                                                                                           |
| `add-voice-surface`    | How to add a front door: the allowlist decided by what the door can show back, the `mcp_tool_calls.surface` **check constraint** whose absence drops audit rows silently, the per-surface latency budget, the feature gate and its browser mirror, and the boot probe. Alexa's 8s ceiling worked through.           |

## 8 subagents

Each declares a model chosen for its job; four run on haiku, four on sonnet, **none on
opus**. The reasoning is in [model-routing.md](model-routing.md).

| agent                  | model  | owns                                                                                                             |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `schema-guardian`      | sonnet | Is this migration safe against real users' data? Ten specific holes, checked against the **live** database.      |
| `mirror-drift-checker` | sonnet | Have the duplicated browser/Edge module pairs diverged _behaviourally_?                                          |
| `plan-executor`        | sonnet | Implement one plan from [plans/](plans/) end to end, and stop rather than invent a decision the plan is missing. |
| `edge-fn-verifier`     | haiku  | Did the deploy actually work — separately from "did the deploy succeed"?                                         |
| `docs-sync-checker`    | haiku  | Have the docs and the code/database come apart? Nine mechanical comparisons.                                     |
| `commit-auditor`       | haiku  | Do the commits meet the house style, and are their verification claims specific?                                 |
| `test-writer`          | sonnet | Write the test a change needs — the right tier, real fixtures, invariants rather than prose, and seen to go red. |
| `latency-auditor`      | haiku  | Does each surface's arithmetic worst case fit the patience of the door it serves?                                |

## 2 hooks

The part that enforces rather than advises.

**`block-destructive-sql.sh`** — PreToolUse on `mcp__supabase__execute_sql` and
`mcp__supabase__apply_migration`. Strips SQL comments _first_, then blocks `DROP`, `TRUNCATE`,
`DELETE`/`UPDATE` without `WHERE`, `DISABLE ROW LEVEL SECURITY`, and `DROP POLICY` with no
`CREATE POLICY` after it. Exit 2 with the reason.

Tested in **both** directions — seven dangerous statements blocked, including one hidden behind
`--`, and six legitimate ones passed, including this repo's own idempotent
`drop policy if exists` + `create policy` idiom. Both halves matter: a guard that blocks
ordinary work gets switched off, and then it guards nothing.

```bash
echo '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"drop table tasks"}}' \
  | .claude/hooks/block-destructive-sql.sh; echo "exit=$?"   # 2
echo '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"select 1"}}' \
  | .claude/hooks/block-destructive-sql.sh; echo "exit=$?"   # 0
```

**`check-after-edit.sh`** — PostToolUse on `Edit|Write`. Runs lint and tests after any `src/`
or `functions/` edit so a break is reported in the turn that caused it rather than at commit
time. **Never blocks** — a formatter disagreement should not stop work mid-thought. Skips the
two generated files.

## Where they were actually used

| artifact                | used for                           | what it caught                                                                                                                                                                      |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-phase`           | beginning the structural-gaps work | Reading the live DB before the code found that the embedding gap had **widened**, which led to the quota discovery.                                                                 |
| `ship-change`           | every block                        | Its "deploy every function bundling a changed shared module" step found **three functions left on stale code** — and the rule had been broken in the very session that wrote it.    |
| `write-tests`           | the `feeds.ts` suite               | Its import rule is what made 57 tests possible on a file that had none; the config comment had claimed they could not be written.                                                   |
| `add-migration`         | three migrations                   | Its "check the constraint before you assume" step caught `tasks.source` rejecting `'agent'` and `ai_events.kind` rejecting `'plan'`.                                                |
| `schema-guardian`       | every migration                    | **Blocked one.** A `*/10` schedule would have fired at 01:00 UTC alongside six parallel ingest invocations all embedding, causing the exact damage the migration existed to repair. |
| `block-destructive-sql` | continuously                       | 13 test cases, both directions — now **asserted by `npm run verify`** rather than kept in a transcript.                                                                             |
| `check-after-edit`      | continuously                       | Reported a 12-test silent drop the same turn it was introduced.                                                                                                                     |

The `schema-guardian` finding is the clearest argument here for giving a review agent real,
read-only access to the thing it reviews: it could only know about the collision by querying the
live `cron.job` table and reading the function's own constants.

### The five newest are not on that list yet

`verify-production`, `debug-silent-failure`, `add-voice-surface`, `test-writer` and
`latency-auditor` have not been invoked in anger, and this table is for things that caught
something. They exist because the procedures they hold had become **tacit** — carried from
session to session in prose and in whoever remembered, which is exactly the state the rest of
this file argues against.

Each is distilled from incidents already recorded elsewhere in these docs rather than imagined:

| artifact               | distilled from                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-production`    | `plan-day` returning 200 having done nothing, visible only in `ai_events` and `mcp_tool_calls`                                                                                                                                                    |
| `debug-silent-failure` | the whole of [gotchas.md](gotchas.md): `plan-day` with no `cron.job` row, `BOOT_ERROR` from a missing export, `IDLE_TIMEOUT` from an unbounded fetch, `log_attributes['event_message']` returning empty strings, a 12-test silent collection drop |
| `add-voice-surface`    | building the Alexa door, where the agent answered correctly in 56s against an 8s ceiling                                                                                                                                                          |
| `test-writer`          | the `write-tests` import rule, which turned 941 untested lines into 57 cases                                                                                                                                                                      |
| `latency-auditor`      | the same 56s, and the fact that `duration_ms` measures the tool round trip and nothing else                                                                                                                                                       |

The claim being made for them is therefore "this procedure was real and is now loadable", not
"this agent found a bug". Three of them say so in their own prompts, which is the point —
`latency-auditor` is told to report an unexercised surface as **unmeasured**, never as fast.

## Review checkpoints

Where a human is in the loop, deliberately:

- **A plan is approved before any code.** The current one was rejected and revised three times
  — to make the news dynamic rather than a fixed list, to deepen the testing strategy, and to
  fix the git conventions.
- **Decision points are raised as questions, not assumed**, when different answers would mean
  materially different work.
- **Destructive operations stop and ask.** A leftover QA account was _disabled_, not deleted.
- **What only a human can check is named as such** in [roadmap.md](roadmap.md), rather than
  quietly passing as done. The standing example: the `agent` happy path from a browser, since no
  user JWT can be minted outside a session.
- **Commit bodies are review artifacts** — each explains the tradeoff and what was rejected, so
  the reasoning can be audited without re-reading the diff.

## Reviewing the process itself

```bash
ls .claude/skills/                                      # 9
grep -h "^name:\|^model:" .claude/agents/*.md | paste - -   # 8, with models
jq '.hooks | keys' .claude/settings.json                # PreToolUse, PostToolUse
wc -l CLAUDE.md                                         # 151, down from 1026
npm run verify                                          # asserts every count above
```
