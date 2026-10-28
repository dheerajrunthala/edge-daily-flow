-- A fifth way a task can come into existence.
--
-- tasks.source already separates 'manual' (typed into the form), 'ai' (Gemini parsed a
-- sentence the user then reviewed in the quick-add preview), 'mcp' (an editor's agent
-- wrote it with no human in the loop) and 'telegram' (parsed from a chat message, no
-- preview step). 'agent' is the conversational one: the user was present and watching,
-- and the task was created as part of an exchange rather than from a single utterance.
--
-- Worth distinguishing rather than folding into 'ai' because the Insights page counts
-- these separately and they mean different things about how much review a task got —
-- which is exactly the question "was this really what I asked for" turns into later.
alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks
  add constraint tasks_source_check
  check (source in ('manual', 'ai', 'mcp', 'telegram', 'agent'));
