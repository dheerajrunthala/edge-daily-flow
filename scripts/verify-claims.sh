#!/usr/bin/env bash
# Every claim this repo makes, checked in one command.
#
#   npm run verify            everything that can be reached from this machine
#   npm run verify -- --local the checks that need no network at all
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# Why this exists
#
# README.md used to end with SQL to paste into a console by hand. That asks a reader to
# trust the numbers in the prose and offers them a way to check only the three claims
# somebody remembered to write out. The rest of this project's claims — 13 database
# assertions, 13 isolates that boot, a hook that blocks a DROP and still lets ordinary work
# through — lived in a session transcript nobody else could re-run.
#
# So: one command, a row per claim, and the real number next to each one.
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# The rule this script is built around
#
# A SKIPPED CHECK IS NEVER A PASS. Checks are grouped by what they need, and anything that
# cannot run says which credential was missing and how to get it. `npm run test:isolation`
# already exits 2 rather than 0 when its tokens are absent, for exactly this reason; this
# script keeps that discipline across all four groups and the exit code reflects failures
# only, with the skip count printed separately so it cannot be read as green.
#
# `npm run build` is deliberately not here. It is a gate before committing, not a claim
# about the product, and it is the slowest thing in the repo.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_ONLY=1 ;;
    -h | --help)
      sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────── result table

PASSED=0
FAILED=0
SKIPPED=0

if [ -t 1 ]; then
  C_PASS=$'\033[32m'
  C_FAIL=$'\033[31m'
  C_SKIP=$'\033[33m'
  C_DIM=$'\033[2m'
  C_OFF=$'\033[0m'
else
  C_PASS='' C_FAIL='' C_SKIP='' C_DIM='' C_OFF=''
fi

# record <PASS|FAIL|SKIP> <claim> <evidence>
record() {
  local status="$1" claim="$2" evidence="$3" colour
  case "$status" in
    PASS)
      PASSED=$((PASSED + 1))
      colour="$C_PASS"
      ;;
    FAIL)
      FAILED=$((FAILED + 1))
      colour="$C_FAIL"
      ;;
    SKIP)
      SKIPPED=$((SKIPPED + 1))
      colour="$C_SKIP"
      ;;
  esac
  printf '%s%-4s%s  %-52s %s\n' "$colour" "$status" "$C_OFF" "$claim" "$evidence"
}

group() { printf '\n%s── %s%s\n' "$C_DIM" "$1" "$C_OFF"; }

# ═══════════════════════════════════════════════════ 1. no network, no credentials needed

group "local — no network, no credentials"

# --- the unit suite ---------------------------------------------------------------------
TEST_OUT=$(npm test 2>&1)
TEST_COUNT=$(printf '%s' "$TEST_OUT" | sed -n 's/^[[:space:]]*Tests[[:space:]]*\([0-9]*\) passed.*/\1/p' | tail -1)
FILE_COUNT=$(printf '%s' "$TEST_OUT" | sed -n 's/^[[:space:]]*Test Files[[:space:]]*\([0-9]*\) passed.*/\1/p' | tail -1)
TEST_TIME=$(printf '%s' "$TEST_OUT" | sed -n 's/^[[:space:]]*Duration[[:space:]]*\([0-9.]*m\{0,1\}s\).*/\1/p' | tail -1)

if printf '%s' "$TEST_OUT" | grep -qE "Tests .*failed|No test files found"; then
  record FAIL "the unit suite passes with no setup" \
    "$(printf '%s' "$TEST_OUT" | grep -E 'Tests ' | tail -1 | tr -s ' ')"
elif [ -n "$TEST_COUNT" ]; then
  record PASS "the unit suite passes with no setup" \
    "$TEST_COUNT tests, $FILE_COUNT files, ${TEST_TIME:-?}"
else
  record FAIL "the unit suite passes with no setup" "could not parse vitest output"
fi

# --- lint -------------------------------------------------------------------------------
LINT_OUT=$(npm run lint 2>&1)
LINT_ERRORS=$(printf '%s' "$LINT_OUT" | grep -cE "^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+error")
LINT_WARNINGS=$(printf '%s' "$LINT_OUT" | grep -cE "^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+warning")
if [ "$LINT_ERRORS" -eq 0 ]; then
  record PASS "eslint reports no errors" \
    "0 errors, $LINT_WARNINGS warnings (shadcn's, in components/ui)"
else
  record FAIL "eslint reports no errors" "$LINT_ERRORS errors"
fi

# --- the destructive-SQL hook, in both directions ---------------------------------------
#
# Both halves matter. A guard that only blocks is untested against the thing it must let
# through, and a guard that blocks ordinary work gets switched off — after which it guards
# nothing. The dangerous case with a leading `--` comment is the one that would pass if the
# hook collapsed newlines before stripping comments.
HOOK=.claude/hooks/block-destructive-sql.sh

declare -a MUST_BLOCK=(
  'drop table tasks'
  'alter table public.tasks drop column notes'
  'truncate table articles'
  'delete from tasks'
  'update tasks set priority = 1'
  'alter table public.news_items disable row level security'
  '-- housekeeping, see the ticket\ndrop table task_notifications'
)
declare -a MUST_PASS=(
  'select 1'
  "delete from tasks where id = '00000000-0000-0000-0000-000000000000'"
  "update tasks set priority = 1 where id = '00000000-0000-0000-0000-000000000000'"
  'drop policy if exists "own tasks" on public.tasks; create policy "own tasks" on public.tasks for select using (auth.uid() = user_id);'
  'create index if not exists tasks_user_idx on public.tasks (user_id)'
  'alter table public.tasks enable row level security'
)

hook_exit() {
  printf '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"%s"}}' \
    "$(printf '%s' "$1" | sed 's/"/\\"/g')" | "$HOOK" >/dev/null 2>&1
  echo $?
}

HOOK_OK=0
HOOK_BAD=""
for q in "${MUST_BLOCK[@]}"; do
  if [ "$(hook_exit "$q")" = "2" ]; then HOOK_OK=$((HOOK_OK + 1)); else HOOK_BAD="not blocked: $q"; fi
done
for q in "${MUST_PASS[@]}"; do
  if [ "$(hook_exit "$q")" = "0" ]; then HOOK_OK=$((HOOK_OK + 1)); else HOOK_BAD="wrongly blocked: $q"; fi
done
HOOK_TOTAL=$((${#MUST_BLOCK[@]} + ${#MUST_PASS[@]}))

if [ "$HOOK_OK" -eq "$HOOK_TOTAL" ]; then
  record PASS "the destructive-SQL hook holds in both directions" \
    "$HOOK_OK/$HOOK_TOTAL — ${#MUST_BLOCK[@]} blocked, ${#MUST_PASS[@]} let through"
else
  record FAIL "the destructive-SQL hook holds in both directions" "$HOOK_OK/$HOOK_TOTAL — $HOOK_BAD"
fi

# --- every subagent declares a model, and none of them is opus --------------------------
AGENT_FILES=$(find .claude/agents -name '*.md' | sort)
AGENT_N=$(printf '%s\n' "$AGENT_FILES" | grep -c . )
NO_MODEL=""
for f in $AGENT_FILES; do
  m=$(sed -n '1,20p' "$f" | sed -n 's/^model:[[:space:]]*//p' | head -1)
  [ -z "$m" ] && NO_MODEL="$NO_MODEL $(basename "$f")"
  [ "$m" = "opus" ] && NO_MODEL="$NO_MODEL $(basename "$f")(opus)"
done
MODEL_MIX=$(grep -h '^model:' $AGENT_FILES | sed 's/^model:[[:space:]]*//' | sort | uniq -c |
  awk '{printf "%s %s, ", $1, $2}' | sed 's/, $//')
if [ -z "$NO_MODEL" ]; then
  record PASS "every subagent declares a model, none is opus" "$AGENT_N agents — $MODEL_MIX"
else
  record FAIL "every subagent declares a model, none is opus" "offenders:$NO_MODEL"
fi

# --- every Edge Function pins verify_jwt in config.toml ---------------------------------
#
# An unlisted function defaults to verify_jwt = true, which rejects every caller of
# anything not authenticated by a Supabase JWT — before the handler runs, so the function
# looks healthy and answers nobody. push-action was one deploy away from this.
FN_NAMES=$(find supabase/functions -maxdepth 1 -mindepth 1 -type d ! -name _shared -exec basename {} \; | sort)
FN_N=$(printf '%s\n' "$FN_NAMES" | grep -c .)
UNPINNED=""
for fn in $FN_NAMES; do
  grep -q "^\[functions\.$fn\]" supabase/config.toml || UNPINNED="$UNPINNED $fn"
done
if [ -z "$UNPINNED" ]; then
  record PASS "every Edge Function pins verify_jwt in config.toml" "$FN_N/$FN_N functions listed"
else
  record FAIL "every Edge Function pins verify_jwt in config.toml" "missing a block:$UNPINNED"
fi

# --- every relative link in the docs resolves -------------------------------------------
BROKEN=""
LINKS=0
for doc in CLAUDE.md README.md AGENTS.md docs/*.md docs/plans/*.md .claude/agents/*.md .claude/skills/*/SKILL.md; do
  [ -f "$doc" ] || continue
  dir=$(dirname "$doc")
  while IFS= read -r target; do
    LINKS=$((LINKS + 1))
    resolved="$dir/${target%%#*}"
    [ -e "$resolved" ] || BROKEN="$BROKEN ${doc}→${target}"
  done < <(grep -oE '\]\([^)]+\)' "$doc" |
    sed 's/^](//; s/)$//' |
    grep -vE '^(https?:|mailto:|#)' |
    grep -E '\.(md|sql|ts|tsx|sh|json|toml)(#.*)?$')
done
if [ -z "$BROKEN" ]; then
  record PASS "every relative link in the docs resolves" "$LINKS links checked"
else
  record FAIL "every relative link in the docs resolves" "broken:$BROKEN"
fi

# --- the README's headline counts are true ----------------------------------------------
#
# The one check here that guards the prose rather than the code. Every number in that line
# has been stale at some point, and a reader who finds one wrong is right to stop trusting
# the rest of the document.
COUNT_LINE=$(grep -m1 'Edge Functions ·' README.md)
num_for() { printf '%s' "$COUNT_LINE" | grep -oE "[0-9]+ $1" | head -1 | grep -oE '^[0-9]+'; }
declare -a CLAIMED=(
  "Edge Functions:$(num_for 'Edge Functions'):$FN_N"
  "migrations:$(num_for 'migrations'):$(find supabase/migrations -name '*.sql' | grep -c .)"
  "tests:$(num_for 'tests'):${TEST_COUNT:-0}"
  "skills:$(num_for 'skills'):$(find .claude/skills -mindepth 1 -maxdepth 1 -type d | grep -c .)"
  "subagents:$(num_for 'subagents'):$AGENT_N"
  "hooks:$(num_for 'hooks'):$(find .claude/hooks -name '*.sh' | grep -c .)"
)
STALE=""
for c in "${CLAIMED[@]}"; do
  label=${c%%:*}
  rest=${c#*:}
  said=${rest%%:*}
  real=${rest##*:}
  if [ "$said" != "$real" ]; then STALE="$STALE $label(says $said, is $real)"; fi
done
if [ -z "$COUNT_LINE" ]; then
  record FAIL "the README's headline counts are true" "no counts line found in README.md"
elif [ -z "$STALE" ]; then
  record PASS "the README's headline counts are true" "all 6 match"
else
  record FAIL "the README's headline counts are true" "stale:$STALE"
fi

# --- CLAUDE.md is as short as four documents say it is ----------------------------------
#
# Four files quote the line count, because "CLAUDE.md is small on purpose" is a claim about
# a number and the number moves every time a rule is added. The pattern below matches a
# three-digit count in the 100s followed by " lines", plus the comment form in process.md,
# and deliberately does not match "1,026 lines" (the before figure) or "941 lines" (feeds.ts).
CLAUDE_REAL=$(grep -c '' CLAUDE.md)
CLAUDE_SAID=$(
  {
    grep -rhoE '1[0-9][0-9] lines' README.md CLAUDE.md docs/*.md
    # Trimmed before "1026" on purpose: that string contains "102" and matched as a count.
    grep -rhoE '# 1[0-9][0-9], down from' docs/*.md
  } | grep -oE '1[0-9][0-9]' | sort -u
)
CLAUDE_N=$(printf '%s\n' "$CLAUDE_SAID" | grep -c .)
if [ "$CLAUDE_N" -eq 0 ]; then
  record FAIL "CLAUDE.md is as short as the docs say" "no document states a line count"
elif [ "$CLAUDE_SAID" = "$CLAUDE_REAL" ]; then
  record PASS "CLAUDE.md is as short as the docs say" \
    "$CLAUDE_REAL lines, agreed by every document that says so"
else
  record FAIL "CLAUDE.md is as short as the docs say" \
    "is $CLAUDE_REAL; documents say $(printf '%s' "$CLAUDE_SAID" | tr '\n' '/')"
fi

# ═════════════════════════════════════════════════════════ 2. network, no credentials

if [ "$LOCAL_ONLY" = "1" ]; then
  group "deployed, live database, cross-account"
  record SKIP "every Edge Function boots and reaches its handler" "--local was passed"
  record SKIP "the 13 database assertions hold" "--local was passed"
  record SKIP "no cross-account leak through match_news_items" "--local was passed"
  record SKIP "every agent tool call is recorded with its surface" "--local was passed"
  record SKIP "stories thread themselves by similarity alone" "--local was passed"
  record SKIP "one account's MCP token cannot touch another's rows" "--local was passed"
else
  group "deployed — needs network, no credentials (the anon key is public by design)"

  BOOT_OUT=$(npm run test:contract 2>&1)
  BOOT_CODE=$?
  BOOT_LINE=$(printf '%s' "$BOOT_OUT" | grep -oE '[0-9]+/[0-9]+ functions booted' | tail -1)
  if [ "$BOOT_CODE" -eq 0 ] && [ -n "$BOOT_LINE" ]; then
    record PASS "every Edge Function boots and reaches its handler" \
      "$BOOT_LINE — each asserted on a handler-authored refusal"
  elif printf '%s' "$BOOT_OUT" | grep -q "could not reach\|ENOTFOUND\|EAI_AGAIN\|request failed"; then
    record SKIP "every Edge Function boots and reaches its handler" \
      "no network: $(printf '%s' "$BOOT_OUT" | grep -m1 'FAIL' | tr -s ' ')"
  else
    record FAIL "every Edge Function boots and reaches its handler" \
      "${BOOT_LINE:-see output} · $(printf '%s' "$BOOT_OUT" | grep -m1 '^FAIL' | tr -s ' ')"
  fi

  # ═══════════════════════════════════════════ 3. the live database — needs an access token

  group "live database — needs SUPABASE_ACCESS_TOKEN (.env.local, same one deploys use)"

  # live <claim> <evidence-on-pass-prefix> <sql|--file path> [--privileged]
  # Exit 3 from live-sql.mjs means "cannot run" and must land as SKIP, never as PASS.
  SQL=scripts/verify/live-sql.mjs

  # Every column below is aliased on purpose. The API answers with JSON objects keyed by
  # column name, and `select count(*), count(distinct x)` names BOTH columns "count" — so
  # JSON.parse keeps only the last and the row comes back a field short, with a plausible
  # number sitting in the wrong place. Three of these queries read wrong that way first.

  DB_ERR=$(node "$SQL" --file scripts/db-checks.sql --privileged 2>&1)
  case $? in
    0) record PASS "the 13 database assertions hold" \
      "scripts/db-checks.sql returned no rows — a pass is silence" ;;
    3) record SKIP "the 13 database assertions hold" \
      "$(printf '%s' "$DB_ERR" | head -1)" ;;
    4) record SKIP "the 13 database assertions hold" \
      "unreachable: $(printf '%s' "$DB_ERR" | head -1)" ;;
    *) record FAIL "the 13 database assertions hold" \
      "$(printf '%s' "$DB_ERR" | grep -m1 'ASSERTION' || printf '%s' "$DB_ERR" | head -1)" ;;
  esac

  # Ask for account B's news with account A's embedding, and count how many of A's rows
  # come back. The guard being tested is `.eq("user_id", ...)` inside a SECURITY DEFINER
  # function, which bypasses RLS — so this is the only thing standing between two accounts.
  LEAK=$(node "$SQL" --privileged --sql "
    with seed as (select user_id, embedding from news_items where embedding is not null limit 1),
         other as (select distinct user_id from news_items
                   where user_id <> (select user_id from seed) limit 1)
    select count(*) as leaked from seed, other,
      match_news_items(other.user_id, seed.embedding, 50, null, 0) m
    where m.id in (select id from news_items where user_id = (select user_id from seed))" 2>&1)
  case $? in
    0)
      if [ "$LEAK" = "0" ]; then
        record PASS "no cross-account leak through match_news_items" \
          "0 of account A's rows returned when asking as account B"
      elif [ -z "$LEAK" ]; then
        record SKIP "no cross-account leak through match_news_items" \
          "needs two accounts with embedded news items; the query matched none"
      else
        record FAIL "no cross-account leak through match_news_items" "$LEAK of A's rows leaked"
      fi
      ;;
    3 | 4) record SKIP "no cross-account leak through match_news_items" "$(printf '%s' "$LEAK" | head -1)" ;;
    *) record FAIL "no cross-account leak through match_news_items" "$(printf '%s' "$LEAK" | head -1)" ;;
  esac

  # The audit trail. Every tool call from every front door writes a row with its surface,
  # which is what makes "the doors have different permissions" checkable after the fact
  # rather than only in the allowlist.
  AUDIT=$(node "$SQL" --sql "
    select count(*)                                                     as calls,
           count(distinct surface)                                      as surfaces,
           count(*) filter (where not ok)                               as failures,
           coalesce(string_agg(distinct surface, '/' order by surface), 'none') as names
    from mcp_tool_calls" 2>&1)
  case $? in
    0)
      total=$(printf '%s' "$AUDIT" | cut -f1)
      surfaces=$(printf '%s' "$AUDIT" | cut -f2)
      failures=$(printf '%s' "$AUDIT" | cut -f3)
      names=$(printf '%s' "$AUDIT" | cut -f4)
      if [ "${total:-0}" -gt 0 ]; then
        record PASS "every agent tool call is recorded with its surface" \
          "$total calls across $surfaces surfaces ($names), $failures failed"
      else
        record FAIL "every agent tool call is recorded with its surface" "mcp_tool_calls is empty"
      fi
      ;;
    3 | 4) record SKIP "every agent tool call is recorded with its surface" "$(printf '%s' "$AUDIT" | head -1)" ;;
    *) record FAIL "every agent tool call is recorded with its surface" "$(printf '%s' "$AUDIT" | head -1)" ;;
  esac

  # Follow-up links are written by link_followups() above a measured 0.90 cosine threshold
  # and nothing else — no keywords, no shared tags. db-checks assertion 7 proves the
  # threshold is enforced; this proves it actually produced links.
  THREADS=$(node "$SQL" --sql "
    select count(*) as linked, count(distinct digest_id) as digests
    from news_items where related_item_id is not null" 2>&1)
  case $? in
    0)
      linked=$(printf '%s' "$THREADS" | cut -f1)
      if [ "${linked:-0}" -gt 0 ]; then
        record PASS "stories thread themselves by similarity alone" \
          "$linked items point at an earlier one, across $(printf '%s' "$THREADS" | cut -f2) digests"
      else
        record FAIL "stories thread themselves by similarity alone" "no linked items"
      fi
      ;;
    3 | 4) record SKIP "stories thread themselves by similarity alone" "$(printf '%s' "$THREADS" | head -1)" ;;
    *) record FAIL "stories thread themselves by similarity alone" "$(printf '%s' "$THREADS" | head -1)" ;;
  esac

  # ══════════════════════════════════════════════════ 4. cross-account — needs two de_ tokens

  group "cross-account — needs two accounts' de_ tokens"

  if [ -z "${DAILY_EDGE_TOKEN_A:-}" ] || [ -z "${DAILY_EDGE_TOKEN_B:-}" ]; then
    record SKIP "one account's MCP token cannot touch another's rows" \
      "no DAILY_EDGE_TOKEN_A/_B — mint them in Settings → Integrations on two accounts"
  else
    ISO_OUT=$(npm run test:isolation 2>&1)
    case $? in
      0) record PASS "one account's MCP token cannot touch another's rows" \
        "$(printf '%s' "$ISO_OUT" | grep -m1 -iE 'passed|unchanged' | tr -s ' ')" ;;
      2) record SKIP "one account's MCP token cannot touch another's rows" \
        "the suite refused to run: $(printf '%s' "$ISO_OUT" | tail -2 | head -1 | tr -s ' ')" ;;
      *) record FAIL "one account's MCP token cannot touch another's rows" \
        "$(printf '%s' "$ISO_OUT" | grep -m1 -iE 'fail' | tr -s ' ')" ;;
    esac
  fi
fi

# ───────────────────────────────────────────────────────────────────────────────── summary

printf '\n'
printf '%s%s passed%s' "$C_PASS" "$PASSED" "$C_OFF"
[ "$FAILED" -gt 0 ] && printf ', %s%s failed%s' "$C_FAIL" "$FAILED" "$C_OFF"
[ "$SKIPPED" -gt 0 ] && printf ', %s%s skipped%s' "$C_SKIP" "$SKIPPED" "$C_OFF"
printf '\n'

if [ "$SKIPPED" -gt 0 ]; then
  printf '%sA skipped check is not a pass. Each one above says what it needed.%s\n' "$C_DIM" "$C_OFF"
fi
printf '%sNot checked here: `npm run build` (a commit gate, not a claim), and everything%s\n' "$C_DIM" "$C_OFF"
printf '%slisted under "Not covered" in docs/testing.md.%s\n' "$C_DIM" "$C_OFF"

[ "$FAILED" -gt 0 ] && exit 1
exit 0
