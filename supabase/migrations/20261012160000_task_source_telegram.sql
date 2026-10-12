-- The Tasks page filters by where a task came from, and "a bot captured this from a chat"
-- is a different provenance from "Gemini parsed this in the browser". Both went through
-- parseTasks(), but only one of them had a human looking at a preview before it saved --
-- and the user filtering their list wants to know which front door a task walked in by.
alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in ('manual', 'ai', 'mcp', 'telegram'));
