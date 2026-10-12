-- Close the API door on the SECURITY DEFINER plumbing.
--
-- Supabase's default grants hand EXECUTE on every new public function to `anon` and
-- `authenticated`, which means each of these was reachable over PostgREST as
-- /rest/v1/rpc/<name> with nothing but the publishable key. `revoke ... from public` does
-- not cover it, because the grant is to those two roles by name.
--
-- The one that mattered was `invoke_edge_function`: it reads `cron_secret` out of Vault,
-- so anyone holding the publishable key could have used it to fire ingest-news,
-- build-digests or send-briefs — with a valid x-cron-secret attached. The others are
-- cron-only, and `get_prefetched_feeds` was already described as service-role-only in
-- CLAUDE.md without actually being so.
--
-- pg_cron is unaffected: its jobs run as the function owner, who always has EXECUTE.

revoke execute on function public.invoke_edge_function(text, jsonb) from anon, authenticated;
revoke execute on function public.fanout_ingest_news() from anon, authenticated;
revoke execute on function public.prefetch_aggregator_feeds() from anon, authenticated;
revoke execute on function public.get_prefetched_feeds(interval) from anon, authenticated;

-- `handle_new_user()` is deliberately left alone. It still carries Postgres's default
-- EXECUTE-to-PUBLIC grant, but it returns `trigger`, and Postgres refuses a direct call
-- with "trigger functions can only be called as triggers" (verified on this project), so
-- there is nothing to reach. Revoking is not worth any risk to the signup trigger.

-- These two are meant to be called from the browser by a signed-in user, and both already
-- refuse a null auth.uid() — but anon has no business reaching them at all.
revoke execute on function public.request_telegram_link() from anon;
revoke execute on function public.unlink_telegram() from anon;
