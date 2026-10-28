---
name: add-migration
description: Add a Supabase migration to this project — file naming, the RLS and grant checklist every new table needs, and how to apply and verify it. Use whenever a change touches the schema (new table, column, index, RPC, constraint, or policy).
---

# Adding a migration

This is production with real users' data. The schema baseline was created by hand; every
change since is a numbered file in `supabase/migrations/` **and** applied to the live
project. Both, or the repo and the database disagree.

## Before writing anything

1. `git pull` — Lovable pushes to this branch.
2. Read the current shape rather than assuming it. Constraints in particular are not in
   the migration files for anything created before Phase 3:
   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.<table>'::regclass;
   ```
   This has mattered twice: `tasks.source` rejected `'agent'` and `ai_events.kind`
   rejected `'plan'`, both discovered only because the constraint was checked first.
3. Check for drift. `news_items_embedding_idx` existed in production and in no file,
   because it was created by hand in the dashboard:
   ```sql
   select indexname, indexdef from pg_indexes where schemaname = 'public';
   ```
   If you find drift, declare it with `if not exists` so the migration is a no-op against
   the live database but true for a fresh one.

## Naming

`supabase/migrations/YYYYMMDDHHMMSS_snake_case_name.sql`, timestamp in UTC, strictly after
the newest existing file.

## Every new table needs all five

A table with RLS on and no policy is invisible; a table with RLS off is readable by anyone
holding the publishable key. Neither fails loudly.

1. `user_id uuid not null references auth.users (id) on delete cascade` — unless it is
   shared reference data like `articles`.
2. `alter table ... enable row level security;`
3. A policy per operation the owner actually needs, each `using (user_id = auth.uid())`.
   Do **not** write an insert policy for a row only a server should create — `topics` has
   none, because creating a topic means embedding its label and the browser never calls
   Gemini.
4. `revoke all on public.<table> from anon;`
5. **Column grants when only some fields are user-writable.** This is the project's
   established pattern and it is easy to forget: `news_items` grants `authenticated`
   UPDATE on only `is_saved` and `read_at`, `api_tokens` only `revoked_at`, `topics` only
   `enabled` and `weight`. An RLS policy cannot express "this column is ours".

## Every new function needs

- `security definer` plus `set search_path = public, extensions` if it touches `vector` —
  the extension is **not** in `public` on this project, and the parameter type will not
  resolve without it.
- The owner resolved *inside* the body, not trusted from an argument:
  `v_user uuid := coalesce(auth.uid(), p_user_id);` lets a signed-in caller only ever
  reach their own rows while leaving the service-role path working.
- `revoke execute on function ... from anon;` — Supabase grants EXECUTE to `anon` and
  `authenticated` by default, which is the hole `20261012093000` closed for the cron
  plumbing. Include the full argument-type list or the revoke silently matches nothing.

## Stop and ask first

`DROP`, `DELETE` without `WHERE`, a type change, or disabling RLS. There is a PreToolUse
hook that blocks these, but it is a net, not a decision.

## Apply and verify

Apply with the Supabase MCP `apply_migration` (not `execute_sql` — that does not record
it). Then **prove it works with a query, not by reading the file**:

```sql
select * from public.match_news_items(
  '<uid>', (select embedding from news_items limit 1), 5, null, 0.5);
```

For anything user-scoped, prove isolation too: seed from user A and ask for user B, and
assert zero of A's rows come back.

## Thresholds are measured, never guessed

Two numbers in this schema were wrong on the first attempt because they were intuited:

- Follow-up similarity at 0.85 was the **median** nearest-neighbour distance, so it would
  have badged half the feed. 0.90 is right.
- Topic matching at 0.60 matched the entire archive, because gemini-embedding-001
  compresses everything into roughly 0.75–0.88. 0.80 is right.

If you add a threshold, run the distribution first and put the numbers in the migration's
comment so the next person does not re-derive them.
