# P1 — Codify the manual verification

**Model: sonnet.** Careful implementation against a known standard, with a database in the
loop. **Size: ~2h.** **Depends on: nothing.**

Load `write-tests` first. It is the strategy; this is the backlog.

## Why

Tiers 3 and 4 of the strategy in [../testing.md](../testing.md) exist as a _practice_ but not
as committed scripts. Everything in them has been run — RLS coverage, cross-user isolation,
boot success — by hand, through the Supabase MCP, in a session transcript nobody else can
re-run.

That is the wrong place for it. A reviewer cannot re-run a transcript, a regression cannot be
caught by one, and the two bug classes these cover have each bitten **twice**:

- a missing export is a **boot failure**, not a type error — the isolate refuses to start and
  pg_net sees `BOOT_ERROR` with nothing in the function logs;
- the ownership guard is the _only_ thing between two accounts, because every tool runs with
  the service role and bypasses RLS entirely.

## 1. `scripts/db-checks.sql`

Plain assertion blocks, no framework:

```sql
do $$ begin
  if exists (
    select 1 from pg_tables t
    where t.schemaname = 'public' and not t.rowsecurity
  ) then
    raise exception 'RLS is off on: %', (
      select string_agg(tablename, ', ') from pg_tables
      where schemaname = 'public' and not rowsecurity
    );
  end if;
end $$;
```

Assert, each in its own block so the failure names itself:

1. **RLS enabled on every `public` table.**
2. **At least one policy** on every table a user reads. (`prefetch_feeds` and
   `prefetch_requests` are deliberate exceptions — RLS on, no policies, service-role only. Let
   the script know.)
3. **`anon` has no EXECUTE** on the SECURITY DEFINER functions: `invoke_edge_function`,
   `fanout_ingest_news`, `fanout_build_digests`, `prefetch_aggregator_feeds`,
   `get_prefetched_feeds`, `link_followups`, `match_*`. Check `has_function_privilege`, and note
   that a `revoke` naming the wrong argument signature silently matches nothing.
4. **Column grants hold**: `authenticated` has UPDATE on exactly `is_saved`/`read_at` for
   `news_items`, `revoked_at` for `api_tokens`, `enabled`/`weight` for `topics` — and
   **nothing else**. Query `information_schema.column_privileges`.
5. **`match_news_items` scoping**: pass account B's id with account A's embedding; assert zero
   of A's rows come back. This is the single most important assertion in the file.
6. **HNSW indexes** exist on `articles.embedding`, `news_items.embedding`, `topics.embedding`,
   with `vector_cosine_ops` — a mismatched operator class means the planner ignores the index.
7. **`link_followups` writes nothing below 0.90.**
8. **Every documented cron job exists** with the documented schedule, and no job shares a
   minute with `repair-embeddings` (see [../decisions.md](../decisions.md#reliability)).

Run it with the Supabase MCP `execute_sql`. A pass is silence.

## 2. `scripts/contract/boot-smoke.ts`

~40 lines. For each of the twelve functions under `supabase/functions/` (excluding `_shared`),
invoke it and assert the response is **not** `BOOT_ERROR`.

Use the cron path for cron functions (`invoke_edge_function`, then read
`net._http_response`) and a plain `fetch` with no credential for user functions — a **401 is a
pass** here, because it proves the isolate booted and the handler ran. Only `BOOT_ERROR`/503
fails.

## 3. `scripts/contract/mcp-isolation.ts`

Needs **two accounts and two `de_…` tokens**, supplied as env vars — ask the owner; do not
create accounts unprompted.

For every id belonging to account A, assert token B gets _not found_, across `get_task`,
`update_task`, `complete_task`, `snooze_task`, `delete_task` and `save_news_item`. Then
**re-read A's rows and assert they are byte-identical**. Negative evidence is the point: an
isolation test that only checks the error message has not checked that nothing was written.

Also assert the 120/hour rate limit returns 429, and a revoked token returns 401 with the same
message as an unknown one.

## 4. Wire them up

Add to `package.json`:

```json
"test:contract": "node --experimental-strip-types scripts/contract/boot-smoke.ts"
```

Leave `npm test` as the fast unit suite. Contract tests hit the network and must not be in the
inner loop.

## Acceptance criteria

- `scripts/db-checks.sql` runs clean against production and **fails loudly** when you
  temporarily break something (prove it — flip one assertion's expectation and watch it raise).
- `boot-smoke.ts` reports all twelve functions booting.
- `mcp-isolation.ts` passes, or is committed runnable with its last recorded output and a note
  saying credentials are needed.
- `docs/testing.md`'s "Not covered" list shrinks by the tiers you codified.
- `npm run build && npm run lint && npm test` green.

## Verification

The scripts _are_ the verification. The one thing to prove separately: that each fails when it
should. A green assertion that cannot go red is decoration.
