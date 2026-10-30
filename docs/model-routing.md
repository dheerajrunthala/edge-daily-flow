# Model routing

Every agent in `.claude/agents/` declares its model explicitly. None of them inherits, and
**none of them runs on Opus.** Eight agents: four haiku, four sonnet. `npm run verify`
asserts both halves of that, so the claim cannot go stale quietly.

That is a deliberate position, not a cost-cutting afterthought. An agent fleet where everything
runs on the most capable model is the multi-agent equivalent of running every query without an
index: it works, it is expensive, and the expense is invisible until it isn't.

## The policy

Pick the cheapest model that can be _reliably_ correct at the task, where "reliably" is judged
against the question: **what does a wrong answer cost, and would a bigger model actually have
got it right?**

That second clause matters. Upgrading a model only helps when the failure mode is _reasoning_.
If the failure mode is a missing instruction, a bigger model fails the same way and costs more.

|            | use                                                                                                              | because                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **haiku**  | procedure-following against a written decision table; comparing two lists; checking an artifact against a rubric | everything needed to decide is already in the prompt, so reasoning capacity buys nothing    |
| **sonnet** | review requiring judgement over a bounded artifact; implementation against a finished spec                       | the failure mode is "missed something subtle", which is what more capability actually fixes |
| **opus**   | open-ended design; diagnosing an unknown failure; work where the shape of the problem is not yet known           | reserved for the orchestrating session, where the hard thinking happens                     |

## The routing

| agent                  | model      | the job, and why that model                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema-guardian`      | **sonnet** | Judgement over a short, high-consequence artifact. A migration is a few hundred lines, so context is cheap — but a missed RLS hole reaches real users' data. Earned its keep: it blocked a migration whose `*/10` schedule would have collided with the ingest fan-out and caused the exact damage the migration existed to repair. Opus would not read SQL better; haiku would not reliably notice a `WHERE` matching two rows when it should match one. |
| `mirror-drift-checker` | **sonnet** | Comparison that needs reasoning rather than diffing. The bug it exists to catch was a one-word signature difference (`Date \| string` vs `Date`) whose consequence was a `RangeError` three call-layers away. Noticing the texts differ is haiku work; noticing the _behaviour_ differs on an ISO-string input is not.                                                                                                                                    |
| `plan-executor`        | **sonnet** | Implementation against a finished spec. The plans in [plans/](plans/) name the files, the utilities, the acceptance criteria and the tests, which removes the open-ended design work. A plan that still needs architectural decisions is unfinished — the agent is told to send it back rather than improvise.                                                                                                                                            |
| `edge-fn-verifier`     | **haiku**  | Procedure-following against a fixed decision table: invoke a known SQL function, read a status code, map it through four documented cases, read back named rows. Every decision it makes is written in its own prompt.                                                                                                                                                                                                                                    |
| `docs-sync-checker`    | **haiku**  | Nine mechanical comparisons: a list from a document against the same list from the code or the database. Each has an unambiguous answer.                                                                                                                                                                                                                                                                                                                  |
| `commit-auditor`       | **haiku**  | Checking commits against a written rubric. The expensive part of a good commit body is _writing_ it; noticing that one merely restates the diff is not.                                                                                                                                                                                                                                                                                                   |
| `test-writer`          | **sonnet** | Implementation against a finished spec, the same shape as `plan-executor`. The `write-tests` skill already fixes the tiers, the import rule and the invariants — but the failure mode is "wrote a test that cannot fail", which is a judgement about the subject under test rather than a lookup. Haiku would pick the tier reliably and notice unreliably that asserting a model's wording tests nothing.                                                |
| `latency-auditor`      | **haiku**  | Arithmetic against a written table: four constants out of the code, four percentiles out of one table, multiply, compare to a stated ceiling. Every answer is a number and every decision is in the prompt. The judgement it does **not** make — whether a door's patience really is eight seconds — is left to the calling session on purpose.                                                                                                           |

## Why the split falls where it does

The honest pattern: **the cheap agents all answer questions with a correct answer that exists
somewhere already** — in the database, in the code, in a rubric. They look it up and compare;
`latency-auditor` is the clearest case of all, where the answer is multiplication. The sonnet
agents all answer "is there something subtly wrong here that nobody has written down yet",
which is a different kind of question.

That is also why none of them is Opus. Every one of these agents has a _bounded_ artifact and a
_stated_ standard. Opus's advantage is on problems where neither is true — and in this project
that work (diagnosing why digests vanished, discovering the embed quota, deciding how the agent
layer should be shaped) stayed in the orchestrating session on purpose, where it had the whole
context rather than a subagent's slice.

## Where the savings actually come from

Model choice is the smaller half. The larger half is **not sending context you do not need**:

- **CLAUDE.md is 151 lines, down from 1,026.** It loads into every single session, so a
  thousand lines of reference material was being paid for on every turn of every conversation
  — including turns that never touched the schema or the news pipeline. The detail moved to
  `docs/`, indexed by a table of "if you are about to do X, read Y", so it is loaded on demand
  by the sessions that need it. This is the single biggest token saving in the project.
- **Skills load on demand.** Nine of them, each a few hundred lines, none resident. The three
  newest are the ones that were most expensive to carry in prose instead —
  `debug-silent-failure` replaces re-deriving a nine-branch diagnostic tree out of
  `gotchas.md` every time something goes quiet.
- **Subagents keep large reads out of the main window.** A fan-out search over a 22k-line
  codebase returns a conclusion, not the files. `schema-guardian` reads four migrations and the
  live schema and returns a verdict.
- **A failed read falls back to a default** rather than retrying, and
  `_shared/features.filterEnabled()` narrows a whole list of users in one query rather than one
  round trip each — the same instinct applied to the product's own costs.

## Product-side model choice

The same reasoning governs the models the _product_ calls, documented in `_shared/gemini.ts`:

|                                         | model                      | why                                                                                            |
| --------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| parsing, digest ranking, the agent loop | `gemini-flash-latest`      | accuracy-sensitive but low volume                                                              |
| per-article summarising                 | `gemini-flash-lite-latest` | high volume, so the cheap tier                                                                 |
| capacity fallback                       | `gemini-flash-lite-latest` | a different pool; a digest ranked by the cheaper model beats no digest                         |
| embeddings                              | `gemini-embedding-001`     | pinned, and must stay pinned — a vector from one model is not comparable with one from another |

And the architectural decision that dwarfs all of them: **the news pipeline embeds and
summarises each article exactly once into a shared pool**, so the marginal cost of a new user
is one Flash call per day rather than a whole ingest. See
[decisions.md](decisions.md#architecture).

## Reviewing this

```bash
# every agent declares a model, and none of them is opus
grep -h "^name:\|^model:" .claude/agents/*.md | paste - -

# the context that loads on every turn
wc -l CLAUDE.md

# both of the above, asserted
npm run verify -- --local
```
