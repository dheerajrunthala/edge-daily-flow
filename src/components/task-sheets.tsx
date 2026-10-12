import { useState } from "react";
import { Check, Clock, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { snoozeOptions } from "@/lib/task-actions";
import type { Task } from "@/lib/task-logic";
import { absoluteDue, dayKey, fromKeys } from "@/lib/tz";
import { ResponsiveModal } from "./responsive-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Not now", with the three answers worth a single tap and a fourth for a real date.
 * Snoozing does not move the due date — it suppresses every ladder rung before the
 * chosen instant — so the sheet says when the task is next going to speak up, not when
 * it is due.
 */
export function SnoozeSheet({
  task,
  tz,
  morningTime,
  onClose,
  onPick,
}: {
  task: Task | null;
  tz: string;
  morningTime: string;
  onClose: () => void;
  onPick: (task: Task, at: Date) => void;
}) {
  const today = dayKey(new Date(), tz);
  const [day, setDay] = useState(today);
  const [time, setTime] = useState("09:00");
  const options = snoozeOptions(tz, morningTime);

  const pick = (at: Date) => {
    if (!task) return;
    onPick(task, at);
    onClose();
  };

  return (
    <ResponsiveModal open={!!task} onOpenChange={(o) => !o && onClose()} title="Snooze until">
      {task && (
        <div className="space-y-4">
          <p className="truncate text-sm text-muted-foreground">{task.title}</p>
          <div className="space-y-2">
            {options.map((o) => (
              <button
                key={o.key}
                onClick={() => pick(o.at)}
                className="flex min-h-12 w-full items-center justify-between rounded-xl border border-border px-4 text-left text-sm transition-calm hover:bg-accent"
              >
                <span className="flex items-center gap-2">
                  <Clock className="size-4 text-muted-foreground" /> {o.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {absoluteDue(o.at.toISOString(), tz)}
                </span>
              </button>
            ))}
          </div>
          <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Pick a time</p>
            <div className="flex gap-2">
              <Input
                type="date"
                value={day}
                min={today}
                onChange={(e) => setDay(e.target.value)}
                className="h-11 min-w-0 flex-1 rounded-xl"
                aria-label="Snooze date"
              />
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-11 w-28 rounded-xl"
                aria-label="Snooze time"
              />
            </div>
            <Button
              className="h-11 w-full rounded-xl"
              onClick={() => pick(fromKeys(day, time, tz))}
              disabled={fromKeys(day, time, tz) <= new Date()}
            >
              Snooze
            </Button>
          </div>
        </div>
      )}
    </ResponsiveModal>
  );
}

/**
 * The long-press menu. Everything here is also reachable another way (tap to edit,
 * swipe to complete or snooze) — a long press is the discoverable route to all of it at
 * once, and the only route to Delete on a phone.
 */
export function TaskMenuSheet({
  task,
  tz,
  onClose,
  onEdit,
  onToggle,
  onSnooze,
  onDelete,
}: {
  task: Task | null;
  tz: string;
  onClose: () => void;
  onEdit: (t: Task) => void;
  onToggle: (t: Task) => void;
  onSnooze: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const done = task?.status === "done";
  const run = (fn: (t: Task) => void) => () => {
    if (!task) return;
    onClose();
    fn(task);
  };
  const items = [
    done
      ? { label: "Mark as not done", icon: RotateCcw, run: run(onToggle) }
      : { label: "Complete", icon: Check, run: run(onToggle) },
    { label: "Edit", icon: Pencil, run: run(onEdit) },
    ...(done ? [] : [{ label: "Snooze…", icon: Clock, run: run(onSnooze) }]),
  ];

  return (
    <ResponsiveModal open={!!task} onOpenChange={(o) => !o && onClose()} title="Task">
      {task && (
        <div className="space-y-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{task.title}</p>
            {task.due_at && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {absoluteDue(task.due_at, tz, task.all_day)}
              </p>
            )}
          </div>
          <div className="space-y-2">
            {items.map((i) => (
              <button
                key={i.label}
                onClick={i.run}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border px-4 text-left text-sm transition-calm hover:bg-accent"
              >
                <i.icon className="size-4 text-muted-foreground" /> {i.label}
              </button>
            ))}
            <button
              onClick={run(onDelete)}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border px-4 text-left text-sm text-destructive transition-calm hover:bg-destructive/10"
            >
              <Trash2 className="size-4" /> Delete
            </button>
          </div>
        </div>
      )}
    </ResponsiveModal>
  );
}
