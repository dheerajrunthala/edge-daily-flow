---
name: start-phase
description: Begin a phase of work on Daily Edge — pull, read the decisions before the code, write the roadmap entry with its exit criteria and what will stay unverified, cut the work into independently shippable blocks, and set the review gates. Use at the start of any multi-step piece of work, before writing code.
---

# Starting a phase

A phase that starts badly is discovered three commits in. This is the order that works here,
and each step exists because skipping it has cost something.

## 1. Pull first

```bash
git pull --ff-only
```

Lovable syncs two-way with the default branch and pushes without warning. Starting from a
stale tree means a merge in the middle of the work instead of before it.

## 2. Read the decisions before the code

Find the relevant section of `CLAUDE.md` and read it _before_ opening any source file. That
file is not a description of the code — it is the decisions, with the reasons, and the failures
with their symptoms. The code only shows the outcome, and the outcome rarely explains itself.

Specifically look for:

- A **"Decisions worth not relitigating"** entry covering what you are about to change. If one
  exists, the argument has already been had.
- A **gotcha** on the subsystem. The gotchas sections are labelled with their cost ("all of
  these cost an hour to find") precisely so the hour is not spent twice.
- A **measurement**. If you are about to pick a number, check whether its distribution has
  already been run. Two thresholds in this project were wrong when intuited.

Then check for drift between the file and reality. `CLAUDE.md` has been stale before: it
specified a similarity threshold the code had already corrected, and listed a shipped feature
as unbuilt. Trust the database and the code over the prose, then **fix the prose**.

## 3. Write the roadmap entry before building

Add the phase to the roadmap in `CLAUDE.md` _first_, with:

- what it delivers,
- its exit criteria,
- and — the part that matters — **what will remain unverified when it is done.**

That last line is the project's most useful habit. "`check-reminders` runs clean but its SMTP
path is still unexercised" sat in the roadmap for weeks, which is the only reason nobody
mistook deployed for working. Write it in the future tense now; it is much harder to admit at
the end.

## 4. Cut the work into blocks

Each block must be:

- **independently shippable** — the tree is green and the product works after it, so the phase
  can stop anywhere;
- **one commit**, with a body worth reading;
- **verifiable** — name the check before writing the code, and prefer a check that reads rows
  over one that reads a status code.

Order by dependency, then by what unblocks the most. Put anything with an external
configuration step (OAuth consent, an app review, a console) last or cut it: it cannot be
parallelised and it is the thing that overruns.

## 5. Set the gates up front

Decide now, not later:

- `npm run build && npm run lint && npm test` must be green before each commit.
- **`schema-guardian`** reviews any migration before it is applied.
- **`mirror-drift-checker`** runs if either side of a duplicated pair is touched.
- **`edge-fn-verifier`** proves any deploy.

The hooks in `.claude/settings.json` enforce the first one and block destructive SQL. The
subagents are a decision, not a net — invoking them is the step.

## 6. Name the human-only item

Some things cannot be verified from here, and the honest move is to assign them rather than
let them pass as done. The standing example: a user-JWT Edge Function's happy path. The
service role key lives only in the platform's secret store, so no session can be minted from a
development environment. The refusals are testable; the success path needs a person with a
browser.

Write that into the phase entry as an owner-assigned task.

## 7. Then build, one block at a time

Use **`ship-change`** for each block's land-it loop and **`write-tests`** for its tests;
**`add-migration`** if the schema moves and **`add-news-feed`** if a source does. Stop and
report between blocks — a phase reviewed at the end is a phase reviewed too late.

## The rest of the toolkit

| when                        | use                                                  |
| --------------------------- | ---------------------------------------------------- |
| the schema moves            | `add-migration`, then the `schema-guardian` subagent |
| a function changed          | `ship-change`, then `deploy-and-verify-fn`           |
| a news source changed       | `add-news-feed`                                      |
| tests need writing          | `write-tests`                                        |
| a mirrored pair was touched | `mirror-drift-checker` subagent                      |
| a deploy needs proving      | `edge-fn-verifier` subagent                          |
