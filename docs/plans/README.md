# Implementation plans

One file per module of remaining work. Each is **self-contained**: a fresh session that has
never seen this codebase can execute it from the plan alone.

## How to pick one up

```
Read docs/plans/<plan>.md and implement it.
```

Then let the `plan-executor` agent do it, or do it yourself. Either way the plan tells you
which skills to load — `start-phase` to begin, `write-tests` for the tests, `ship-change` to
land it, `add-migration` if the schema moves.

## What every plan guarantees

So that nothing has to be re-derived:

- **Why**, not just what — the problem it solves and what breaks without it.
- **Files to touch**, by path.
- **What to reuse**, by path, so nothing gets a second implementation.
- **Acceptance criteria** — the definition of done, not a vibe.
- **Tests to write**, named.
- **Verification** through the production path, because a 200 is not success.
- **The recommended model**, so cost matches difficulty.

A plan that still needs an architectural decision is **not finished**. Send it back rather than
improvising mid-implementation — that decision belongs here, reviewed, where the next person
can also read it.

## The queue

Ordered by value. Each is independent unless a dependency is named.

| plan                                           | what                                                                          | model  | size       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ---------- |
| [P1-codify-tests.md](P1-codify-tests.md)       | turn the manual production verification into runnable scripts (tiers 3 and 4) | sonnet | ~2h        |
| [P2-insights.md](P2-insights.md)               | make the thinnest page real, using the agent audit trail                      | sonnet | ~1.5h      |
| [P3-calendar-export.md](P3-calendar-export.md) | "Add to calendar" on a task via `.ics`, no OAuth                              | haiku  | ~0.5h      |
| [P4-oauth-alexa.md](P4-oauth-alexa.md)         | one OAuth2 endpoint → Alexa account linking **and** ChatGPT as an MCP client  | opus   | ~1 day     |
| [P5-calendar-sync.md](P5-calendar-sync.md)     | two-way Google Calendar, so the planner knows when you are free               | sonnet | ~1 day     |
| [P6-whatsapp.md](P6-whatsapp.md)               | a fourth notification channel; the architecture already fans out              | sonnet | ~0.5h code |
| [P7-weekly-review.md](P7-weekly-review.md)     | a Sunday retrospective email                                                  | sonnet | ~0.5h      |

## Status

| plan               | status                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- |
| P1 codify tests    | **done** — `scripts/db-checks.sql`, `boot-smoke`, `mcp-isolation`                  |
| P2 Insights        | **done** — every number traces to a row                                            |
| P3 calendar export | **done** — `.ics` export, plus a follow-up polishing commit                        |
| P4 OAuth + Alexa   | **mostly done** — skill and implicit-grant linking shipped; ChatGPT connector left |
| P5 calendar sync   | not started                                                                        |
| P6 WhatsApp        | not started                                                                        |
| P7 weekly review   | not started                                                                        |

A done plan keeps its file rather than being deleted: the plan and the commit that fulfilled
it, read together, are the evidence that the work was designed before it was written.
