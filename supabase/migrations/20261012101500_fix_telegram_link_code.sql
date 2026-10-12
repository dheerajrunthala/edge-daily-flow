-- Fix: request_telegram_link() failed with "function gen_random_bytes(integer) does not
-- exist".
--
-- pgcrypto lives in the `extensions` schema on Supabase, and the function is correctly
-- declared `set search_path = ''`, so an unqualified gen_random_bytes() resolves to
-- nothing. Qualifying it as extensions.gen_random_bytes() would work but pins us to where
-- Supabase happens to install pgcrypto today.
--
-- gen_random_uuid() is in pg_catalog (built in since Postgres 13), which is always on the
-- search path even when it is set to ''. It draws from the same strong random source, and
-- 32 hex characters is 128 bits — ample for a single-use code that expires in 15 minutes,
-- and already inside Telegram's start-payload alphabet ([A-Za-z0-9_-]) with no translation.

create or replace function public.request_telegram_link()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_exp  timestamptz := now() + interval '15 minutes';
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  v_code := replace(gen_random_uuid()::text, '-', '');

  insert into public.telegram_links (user_id, code, code_expires_at)
  values (v_user, v_code, v_exp)
  on conflict (user_id) do update
    -- Deliberately leaves chat_id alone: asking for a new code while already linked is
    -- re-linking, not unlinking.
    set code = excluded.code,
        code_expires_at = excluded.code_expires_at,
        updated_at = now();

  return query select v_code, v_exp;
end;
$$;

revoke execute on function public.request_telegram_link() from public, anon;
grant execute on function public.request_telegram_link() to authenticated;
