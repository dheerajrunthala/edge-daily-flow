-- The MCP server's front door: long-lived API tokens, a call log, and the two small
-- schema additions the tools need.
--
-- Why a token at all, when every other user-facing function takes a Supabase JWT: an MCP
-- client is a config file, not a browser. `claude mcp add --header "Authorization: Bearer
-- ..."` is pasted once and expected to work for months, and a Supabase access token
-- expires in an hour. So this is a credential the user mints deliberately, can name, can
-- see the last use of, and can revoke — closer to a GitHub PAT than to a session.
--
-- The token is minted *in the database*, never by the browser, for the same reason
-- request_telegram_link() mints the Telegram code there: the browser should not be the
-- thing that invents a credential, and the plaintext should exist in exactly one response
-- and then nowhere ever again. Only the sha256 is stored, so a dump of this table cannot
-- be replayed against the API.

-- ---------------------------------------------------------------- api_tokens

create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The user's own label ("MacBook — Claude Code"), so a list of tokens is reviewable.
  name text not null check (char_length(name) between 1 and 60),
  -- sha256 of the plaintext, hex. Unique: it is the lookup key on every MCP request, and
  -- two rows hashing the same would mean two users share a credential.
  token_hash text not null unique,
  -- "de_1a2b3c4d" — enough to tell two tokens apart in the UI, useless as a credential.
  prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- The hot path: hash -> user, for live tokens only.
create index if not exists api_tokens_hash_idx
  on public.api_tokens (token_hash) where revoked_at is null;
create index if not exists api_tokens_user_idx on public.api_tokens (user_id);

alter table public.api_tokens enable row level security;

-- The owner may list their tokens and revoke them. There is deliberately no INSERT
-- policy: tokens come from create_api_token() below, which is the only place the
-- plaintext exists.
drop policy if exists "api_tokens are readable by their owner" on public.api_tokens;
create policy "api_tokens are readable by their owner"
  on public.api_tokens for select to authenticated using (user_id = auth.uid());

drop policy if exists "api_tokens are revocable by their owner" on public.api_tokens;
create policy "api_tokens are revocable by their owner"
  on public.api_tokens for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "api_tokens are deletable by their owner" on public.api_tokens;
create policy "api_tokens are deletable by their owner"
  on public.api_tokens for delete to authenticated using (user_id = auth.uid());

-- RLS controls which *rows* a user sees, not which columns, and the owner has no reason
-- to read even their own hash back. Column-level grants are the only thing that actually
-- withholds it, so the frontend selects named columns (never `*`) and `token_hash` is not
-- among the ones it is allowed to ask for.
revoke all on public.api_tokens from anon, authenticated;
grant select (id, user_id, name, prefix, last_used_at, revoked_at, created_at)
  on public.api_tokens to authenticated;
grant update (revoked_at) on public.api_tokens to authenticated;
grant delete on public.api_tokens to authenticated;

-- ---------------------------------------------------------------- minting

/**
 * Mint one token and return the plaintext exactly once.
 *
 * Randomness: two gen_random_uuid() calls, hex, concatenated — 256 bits. The same
 * reasoning as 20261012101500: pgcrypto's gen_random_bytes() lives in the `extensions`
 * schema and is unreachable from a function with `search_path = ''`, while
 * gen_random_uuid() is in pg_catalog and draws on the same strong random source.
 * sha256() is likewise a pg_catalog builtin (Postgres 11+), so the hash needs no
 * extension either.
 */
create or replace function public.create_api_token(p_name text)
returns table (id uuid, token text, prefix text, name text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_token text;
  v_row   public.api_tokens;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if v_name is null then
    v_name := 'MCP token';
  end if;
  v_name := left(v_name, 60);

  -- A ceiling so a runaway script cannot fill the table. Revoked tokens still count
  -- until deleted, which is the honest reading of "how many have you created".
  if (select count(*) from public.api_tokens t where t.user_id = v_user) >= 20 then
    raise exception 'token limit reached — revoke and delete an existing token first';
  end if;

  v_token := 'de_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  insert into public.api_tokens (user_id, name, token_hash, prefix)
  values (
    v_user,
    v_name,
    encode(sha256(v_token::bytea), 'hex'),
    left(v_token, 11)
  )
  returning * into v_row;

  return query select v_row.id, v_token, v_row.prefix, v_row.name, v_row.created_at;
end;
$$;

revoke execute on function public.create_api_token(text) from public, anon;
grant execute on function public.create_api_token(text) to authenticated;

-- ---------------------------------------------------------------- call log

-- One row per MCP tool call. Two jobs: the rate limit counts it, and it is the only
-- record of what an agent did on the user's behalf — which matters more here than for
-- any other front door, because nobody is watching the screen when it happens.
--
-- Deliberately not ai_events: these are not Gemini calls, they have no token counts, and
-- they need a tool name and an outcome. Folding them in would have meant adding two
-- columns that are null for every other kind, and polluting the per-user AI rate limit
-- with calls that cost nothing.
create table if not exists public.mcp_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Kept on delete set null so revoking and deleting a token does not erase the history
  -- of what it did.
  token_id uuid references public.api_tokens (id) on delete set null,
  tool text not null,
  ok boolean not null,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

-- The rate-limit query: calls for this token since a cutoff.
create index if not exists mcp_tool_calls_token_time_idx
  on public.mcp_tool_calls (token_id, created_at desc);
create index if not exists mcp_tool_calls_user_time_idx
  on public.mcp_tool_calls (user_id, created_at desc);

alter table public.mcp_tool_calls enable row level security;

-- Owner-readable, service-role-written: same split as task_notifications.
drop policy if exists "mcp_tool_calls are readable by their owner" on public.mcp_tool_calls;
create policy "mcp_tool_calls are readable by their owner"
  on public.mcp_tool_calls for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- schema additions

-- A task created by an agent is neither hand-typed nor Gemini-parsed, and the difference
-- is worth keeping: it is the one source where no human saw the task before it was saved.
alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in ('manual', 'ai', 'mcp'));

-- What "tomorrow morning" means. get_context hands this to the client so a reminder the
-- user asked for in words lands at the hour they actually start work, rather than at
-- whatever hour the model picks. Lives on notification_prefs because it is a property of
-- when the user wants to be disturbed, next to quiet hours.
alter table public.notification_prefs
  add column if not exists morning_time time not null default '09:00:00';
