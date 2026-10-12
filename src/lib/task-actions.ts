import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { qk } from "./queries";
import { nextOccurrenceAhead, type Task } from "./task-logic";
import { addDaysKey, dayKey, fromKeys, partsInTz } from "./tz";

/**
 * Every mutation on this page is undoable, so each one is written as a plain function
 * that takes the rows *as they were* and can put them back. Hooks wrap them to
 * invalidate and to raise the toast; the undo handler calls the inverse directly.
 *
 * Undo is not a nicety on a reminder app. "Complete" is one tap away from a swipe you
 * did not mean, and a recurring task completed by accident has already rolled its due
 * date forward — without an undo the user has to work out by hand which occurrence they
 * destroyed. That is why the inverse restores the exact fields rather than guessing.
 */

// ---------- primitives ----------

export async function completeOne(task: Task, tz: string) {
  if (task.recurrence !== "none" && task.due_at) {
    const { error: e1 } = await supabase
      .from("task_completions")
      .insert({ task_id: task.id, due_at: task.due_at });
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from("tasks")
      .update({
        due_at: nextOccurrenceAhead(task.due_at, task.recurrence, tz, task.all_day),
        last_reminded_at: null,
        snoozed_until: null,
      })
      .eq("id", task.id);
    if (e2) throw e2;
    return;
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("tasks")
    .update({ status: "done", completed_at: now })
    .eq("id", task.id);
  if (error) throw error;
  const { error: logErr } = await supabase
    .from("task_completions")
    .insert({ task_id: task.id, due_at: task.due_at, completed_at: now });
  if (logErr) throw logErr;
}

/** Put a completed task back exactly as `before` had it, and un-log the completion. */
export async function uncompleteOne(before: Task) {
  const { error } = await supabase
    .from("tasks")
    .update({
      status: before.status,
      completed_at: before.completed_at,
      due_at: before.due_at,
      last_reminded_at: before.last_reminded_at,
      snoozed_until: before.snoozed_until,
    })
    .eq("id", before.id);
  if (error) throw error;
  // Scoped to the occurrence that was just logged, so an older completion of the same
  // recurring task survives an undo of the newest one.
  let q = supabase.from("task_completions").delete().eq("task_id", before.id);
  q = before.due_at ? q.eq("due_at", before.due_at) : q.is("due_at", null);
  const { error: delErr } = await q;
  if (delErr) throw delErr;
}

export async function reopenOne(task: Task) {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "todo", completed_at: null, snoozed_until: null })
    .eq("id", task.id);
  if (error) throw error;
  const { error: delErr } = await supabase.from("task_completions").delete().eq("task_id", task.id);
  if (delErr) throw delErr;
}

export async function setSnooze(ids: string[], until: string | null) {
  const { error } = await supabase.from("tasks").update({ snoozed_until: until }).in("id", ids);
  if (error) throw error;
}

export async function setDueAt(ids: string[], dueAt: string | null, allDay?: boolean) {
  const patch: { due_at: string | null; last_reminded_at: null; all_day?: boolean } = {
    due_at: dueAt,
    // A new due time is a new occurrence, so the old reminder stamp must not suppress it.
    last_reminded_at: null,
  };
  if (allDay !== undefined) patch.all_day = allDay;
  const { error } = await supabase.from("tasks").update(patch).in("id", ids);
  if (error) throw error;
}

export async function setTagsOn(task: Task, tags: string[]) {
  const { error } = await supabase.from("tasks").update({ tags }).eq("id", task.id);
  if (error) throw error;
}

export async function fetchTaskRows(ids: string[]): Promise<Task[]> {
  const { data, error } = await supabase.from("tasks").select("*").in("id", ids);
  if (error) throw error;
  return data ?? [];
}

export async function deleteTasks(ids: string[]) {
  const { error } = await supabase.from("tasks").delete().in("id", ids);
  if (error) throw error;
}

/**
 * Re-insert deleted rows with their original ids, which is what makes "Undo" after a
 * delete honest rather than a lookalike: the task keeps its id, so anything that
 * referenced it still does. Its `task_completions` and ladder rows went with the
 * cascade and do not come back — the ladder simply starts again.
 */
export async function restoreTasks(rows: Task[]) {
  const { error } = await supabase.from("tasks").insert(rows);
  if (error) throw error;
}

// ---------- snooze targets ----------

export type SnoozeOption = { key: string; label: string; at: Date };

/**
 * The four answers to "not now". `morningTime` is the user's own `morning_time`, the
 * same value the MCP server resolves "tomorrow morning" against, so snoozing and asking
 * Claude to reschedule land at the same hour.
 */
export function snoozeOptions(tz: string, morningTime = "09:00", now = new Date()) {
  const today = dayKey(now, tz);
  const h = partsInTz(now, tz).h;
  // Past 9pm "tonight" has already happened; roll it to tomorrow rather than offering
  // the user a snooze that fires immediately.
  const tonightDay = h >= 21 ? addDaysKey(today, 1) : today;
  const morning = (morningTime || "09:00").slice(0, 5);
  return [
    { key: "1h", label: "1 hour", at: new Date(now.getTime() + 3600_000) },
    { key: "tonight", label: "Tonight", at: fromKeys(tonightDay, "21:00", tz) },
    {
      key: "tomorrow",
      label: "Tomorrow morning",
      at: fromKeys(addDaysKey(today, 1), morning, tz),
    },
  ] satisfies SnoozeOption[];
}

// ---------- hooks ----------

/** Invalidate everything a task mutation can have changed. */
function useRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: qk.tasks });
    qc.invalidateQueries({ queryKey: qk.completions });
  };
}

export function useTaskActions(tz: string) {
  const refresh = useRefresh();
  const fail = (e: unknown) => toast.error((e as Error).message || "Something went wrong");

  /** Raise a toast whose action runs `inverse` and refreshes. */
  const undoable = (message: string, inverse: () => Promise<void>) =>
    toast.success(message, {
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            await inverse();
            refresh();
          } catch (e) {
            fail(e);
          }
        },
      },
    });

  return {
    /** Complete one or many, with a single undo that reverses all of them. */
    complete: async (tasks: Task[]) => {
      const before = tasks.filter((t) => t.status !== "done");
      if (!before.length) return;
      try {
        for (const t of before) await completeOne(t, tz);
        refresh();
        const recurring = before.some((t) => t.recurrence !== "none");
        undoable(
          before.length > 1
            ? `${before.length} tasks completed`
            : recurring
              ? "Done — next one scheduled"
              : "Task completed",
          async () => {
            for (const t of before) await uncompleteOne(t);
          },
        );
      } catch (e) {
        refresh();
        fail(e);
      }
    },

    reopen: async (task: Task) => {
      try {
        await reopenOne(task);
        refresh();
      } catch (e) {
        refresh();
        fail(e);
      }
    },

    snooze: async (tasks: Task[], until: Date) => {
      if (!tasks.length) return;
      const before = tasks.map((t) => ({ id: t.id, snoozed_until: t.snoozed_until }));
      try {
        await setSnooze(
          tasks.map((t) => t.id),
          until.toISOString(),
        );
        refresh();
        undoable(tasks.length > 1 ? `${tasks.length} tasks snoozed` : "Snoozed", async () => {
          for (const b of before) await setSnooze([b.id], b.snoozed_until);
        });
      } catch (e) {
        refresh();
        fail(e);
      }
    },

    reschedule: async (tasks: Task[], dueAt: Date | null, allDay?: boolean) => {
      if (!tasks.length) return;
      const before = tasks.map((t) => ({ id: t.id, due_at: t.due_at, all_day: t.all_day }));
      try {
        await setDueAt(
          tasks.map((t) => t.id),
          dueAt ? dueAt.toISOString() : null,
          allDay,
        );
        refresh();
        undoable(tasks.length > 1 ? `${tasks.length} tasks moved` : "Rescheduled", async () => {
          for (const b of before) await setDueAt([b.id], b.due_at, b.all_day);
        });
      } catch (e) {
        refresh();
        fail(e);
      }
    },

    /** Add or remove one tag across a selection, leaving the other tags alone. */
    tag: async (tasks: Task[], name: string, on: boolean) => {
      if (!tasks.length) return;
      const before = tasks.map((t) => ({ task: t, tags: t.tags }));
      try {
        for (const t of tasks) {
          const next = on
            ? t.tags.includes(name)
              ? t.tags
              : [...t.tags, name]
            : t.tags.filter((x) => x !== name);
          if (next !== t.tags) await setTagsOn(t, next);
        }
        refresh();
        undoable(on ? `Tagged “${name}”` : `Removed “${name}”`, async () => {
          for (const b of before) await setTagsOn(b.task, b.tags);
        });
      } catch (e) {
        refresh();
        fail(e);
      }
    },

    remove: async (tasks: Task[]) => {
      if (!tasks.length) return;
      // Read the rows back before deleting: a stale copy from the cache would restore
      // whatever the list happened to be showing rather than what was really there.
      try {
        const rows = await fetchTaskRows(tasks.map((t) => t.id));
        await deleteTasks(rows.map((r) => r.id));
        refresh();
        undoable(rows.length > 1 ? `${rows.length} tasks deleted` : "Task deleted", () =>
          restoreTasks(rows),
        );
      } catch (e) {
        refresh();
        fail(e);
      }
    },
  };
}
