# Documentation map

`CLAUDE.md` at the repo root holds the guidelines that must be in context for every session —
151 lines. Everything else lives here and is loaded on demand.

That split is deliberate and is the project's biggest token saving: `CLAUDE.md` was 1,026 lines
and loaded on every turn of every conversation, including turns that never touched the schema or
the news pipeline. See [model-routing.md](model-routing.md).

## Start here

|                                    |                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | System overview, components, data flow, tech stack, key decisions. The best single entry point.    |
| [mcp-workflow.md](mcp-workflow.md) | **Model Context Protocol in both directions** — as the development loop, and as a product surface. |
| [process.md](process.md)           | The skills, subagents and hooks in `.claude/`, and where each was actually used.                   |
| [decisions.md](decisions.md)       | Decisions worth not relitigating, plus every measured constant and how it was measured.            |

## Subsystems

|                                      |                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [data-model.md](data-model.md)       | Every table, and the column-grant pattern RLS cannot express.                                        |
| [news-pipeline.md](news-pipeline.md) | How ~600 headlines become one reader's twenty, the cost model, the source map, and the feed gotchas. |
| [agent-layer.md](agent-layer.md)     | The conversational door, the planner, vector retrieval, topics, feature switches.                    |
| [mcp-server.md](mcp-server.md)       | The `mcp` Edge Function: transport, auth, the 13 tools.                                              |
| [notifications.md](notifications.md) | Channels, the escalation ladder, quiet hours, browser notifications, Telegram.                       |
| [operations.md](operations.md)       | The cron schedule, what every Edge Function does, how to run any of it by hand.                      |

## Working here

|                                      |                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [testing.md](testing.md)             | The six tiers, what exists, and **what is deliberately not covered**.                           |
| [gotchas.md](gotchas.md)             | Everything that cost an hour to find. Most of it presented as _silence_. Read before debugging. |
| [model-routing.md](model-routing.md) | Which model each agent runs on, and why none of them is Opus.                                   |
| [roadmap.md](roadmap.md)             | What is built, what is verified, and what is **not yet exercised**.                             |
| [plans/](plans/)                     | Self-contained implementation plans — pick one up in a fresh session.                           |

## How to read this repo quickly

If you are evaluating rather than contributing, in this order:

1. [architecture.md](architecture.md) — what it is and how it fits together.
2. [mcp-workflow.md](mcp-workflow.md) — the part that is unusual.
3. [decisions.md](decisions.md) — the reasoning, including the two thresholds that were wrong
   when guessed.
4. [process.md](process.md) — the tooling, with the findings it produced.
5. `git log --oneline pre-hackathon..HEAD` and then any commit body in full. The bodies carry
   the tradeoffs.
6. [roadmap.md](roadmap.md) — specifically each phase's "not yet exercised" list, which is
   where the honest limits are.

Claims in these documents are reproducible, and you do not have to take any of them on faith:

```bash
npm run verify              # 13s. Add -- --local for the checks that need no network.
```

One PASS/FAIL row per claim with the real number beside it, including the counts these
documents quote. A check it could not run prints what it needed and counts as a **skip, never
a pass**. See [testing.md](testing.md) for the tiers behind it, and
[operations.md](operations.md) for why this exists instead of CI.
