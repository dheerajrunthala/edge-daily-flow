-- Close the vector RPCs properly. `revoke from anon` was not enough.
--
-- Postgres grants EXECUTE on every new function to **PUBLIC**, and `anon` inherits it. So
-- revoking from `anon` by name leaves the PUBLIC grant intact and the function still
-- reachable over PostgREST with nothing but the publishable key. 20261012093000 got this
-- right for the cron plumbing by accident of wording; 20261028090000 and 20261028100000 did
-- not, and their comments claimed a protection that was not actually in place.
--
-- Found by Supabase's own security advisor while checking whether the repo was safe to make
-- public. It was not, and the exposure was not theoretical:
--
--   * match_news_items resolves its owner as coalesce(auth.uid(), p_user_id). With no JWT
--     auth.uid() is null, so an unauthenticated caller passing someone else's user_id read
--     **that user's news items** — the exact bypass the coalesce was written to prevent, left
--     open because the revoke that was supposed to make the null branch unreachable did not.
--   * match_topics_pool leaked the same way, exposing a reader's topics, i.e. their interests.
--   * match_articles bypassed the `to authenticated` RLS policy on articles, handing the whole
--     shared pool plus an unauthenticated HNSW scan to anyone.
--   * link_followups **writes**. Anonymous callers could set related_item_id on any user's rows.
--
-- The lesson worth keeping: a SECURITY DEFINER function is only as private as its *least*
-- restrictive grant, and PUBLIC is a grant. Always revoke from PUBLIC as well as by role, and
-- verify with the advisor rather than trusting the migration comment.

revoke execute on function
  public.match_news_items(uuid, extensions.vector, integer, timestamptz, double precision)
  from public, anon;

revoke execute on function
  public.match_articles(extensions.vector, integer, date, text[], double precision)
  from public, anon;

revoke execute on function
  public.match_topics_pool(uuid, date, integer, double precision)
  from public, anon;

-- This one writes, so authenticated loses it too: it runs only inside build-digests on the
-- service role, and nothing in the browser has any business calling it.
revoke execute on function
  public.link_followups(uuid, uuid, integer, double precision)
  from public, anon, authenticated;

-- The two search functions stay callable by a signed-in user, which is the intent: they
-- resolve the owner from auth.uid() and therefore cannot reach another account's rows.
grant execute on function
  public.match_news_items(uuid, extensions.vector, integer, timestamptz, double precision)
  to authenticated;
grant execute on function
  public.match_articles(extensions.vector, integer, date, text[], double precision)
  to authenticated;
grant execute on function
  public.match_topics_pool(uuid, date, integer, double precision)
  to authenticated;
