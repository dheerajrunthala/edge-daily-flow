#!/usr/bin/env bash
# PreToolUse guard for the Supabase MCP write tools.
#
# CLAUDE.md says to stop and ask before destructive SQL against production. This is the
# net under that instruction: an instruction is a request, and an exit code is a rule.
#
# Reads the hook payload on stdin, inspects the SQL, and exits 2 to block with the reason
# on stderr. Anything it does not recognise as dangerous passes through untouched — a
# guard that blocks ordinary work gets switched off, and then it guards nothing.
set -uo pipefail

payload=$(cat)

# tool_input.query (execute_sql) or tool_input.sql — whichever this tool uses.
sql=$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
print(ti.get("query") or ti.get("sql") or "")
' 2>/dev/null)

[ -z "$sql" ] && exit 0

# Strip -- comments and collapse whitespace so a pattern cannot be hidden in formatting.
normalized=$(printf '%s' "$sql" | sed 's/--.*$//' | tr '\n\t' '  ' | tr -s ' ')
lower=$(printf '%s' "$normalized" | tr '[:upper:]' '[:lower:]')

block() {
  echo "BLOCKED by .claude/hooks/block-destructive-sql.sh: $1" >&2
  echo "" >&2
  echo "This is production with real users' data. If you genuinely intend this, ask the" >&2
  echo "owner first and have them run it, or narrow the statement." >&2
  exit 2
}

case "$lower" in
  *"drop table"*)                block "DROP TABLE" ;;
  *"drop schema"*)               block "DROP SCHEMA" ;;
  *"drop database"*)             block "DROP DATABASE" ;;
  *"drop column"*)               block "DROP COLUMN — data loss is not reversible" ;;
  *"truncate"*)                  block "TRUNCATE" ;;
  *"disable row level security"*) block "disabling RLS — every row becomes world-readable" ;;
  *"drop policy"*)
    # Dropping a policy is fine when it is immediately recreated, which is this repo's
    # idempotent pattern. Dropping without recreating leaves the table invisible.
    case "$lower" in
      *"create policy"*) : ;;
      *) block "DROP POLICY with no CREATE POLICY after it" ;;
    esac ;;
esac

# DELETE or UPDATE with no WHERE rewrites the whole table.
case "$lower" in
  *delete\ from*)
    case "$lower" in *where*) : ;; *) block "DELETE without WHERE" ;; esac ;;
esac
case "$lower" in
  *update\ *set\ *)
    case "$lower" in *where*) : ;; *) block "UPDATE without WHERE" ;; esac ;;
esac

exit 0
