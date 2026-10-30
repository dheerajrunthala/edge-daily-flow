-- One audit table, now four front doors.
--
-- mcp_tool_calls was built when the MCP server was the only caller, so the tool name and
-- the token were enough to say who did what. The chat agent, the Telegram bot and the
-- morning planner reach the same tool bodies, and two of those carry no API token at all
-- — so without this column a row with token_id null is unattributable, and the table
-- cannot answer the one question it exists to answer: what did it do while I was asleep.
--
-- The surfaces differ in blast radius, which is why this is worth a column rather than a
-- guess from token_id: `mcp` is a developer's editor, `voice` is a device in a room that
-- may have misheard the user, and `planner` is cron acting with nobody present.
--
-- Defaulted to 'mcp' so the 74 existing rows stay true — every one of them was an MCP
-- call — and so an older deployed copy of the function keeps inserting successfully
-- during the window between this migration and its redeploy.
alter table public.mcp_tool_calls
  add column if not exists surface text not null default 'mcp'
  check (surface in ('mcp', 'chat', 'voice', 'telegram', 'planner'));

-- The rate limit counts per token per hour; the Insights page will want per surface.
create index if not exists mcp_tool_calls_user_surface_idx
  on public.mcp_tool_calls (user_id, surface, created_at desc);
