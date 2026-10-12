import { Check, Repeat, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, dayKey } from "@/lib/tz";
import type { Task } from "@/lib/task-logic";
import type { Tag } from "@/lib/queries";
import { TagChip } from "./common";

export function dueLabel(task: Task, tz: string) {
  if (!task.due_at) return null;
  const today = dayKey(new Date(), tz);
  const k = dayKey(task.due_at, tz);
  const date = k === today ? "Today" : fmt(task.due_at, tz, { day: "numeric", month: "short" });
  if (task.all_day) return date;
  return `${date} · ${fmt(task.due_at, tz, { hour: "numeric", minute: "2-digit" })}`;
}

export function TaskItem({
  task,
  tz,
  tags,
  onToggle,
  onOpen,
  overdue,
}: {
  task: Task;
  tz: string;
  tags: Tag[];
  onToggle: (t: Task) => void;
  onOpen?: (t: Task) => void;
  overdue?: boolean | undefined;
}) {
  const done = task.status === "done";
  const color = (n: string) => tags.find((t) => t.name === n)?.color;
  return (
    <div className="group flex items-start gap-3 rounded-xl px-2 py-2.5 transition-calm hover:bg-accent/60">
      <button
        onClick={() => onToggle(task)}
        aria-label={done ? "Mark as not done" : "Mark as done"}
        className="-m-2 flex size-11 shrink-0 items-center justify-center"
      >
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full border-[1.5px] transition-calm",
            done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 hover:border-primary",
            task.priority === "high" && !done && "border-overdue",
          )}
        >
          {done && <Check className="size-3" />}
        </span>
      </button>
      <button onClick={() => onOpen?.(task)} className="min-w-0 flex-1 pt-0.5 text-left">
        <p className={cn("text-sm", done && "text-muted-foreground line-through")}>{task.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {task.due_at && <span className={cn(overdue && "font-medium text-overdue")}>{dueLabel(task, tz)}</span>}
          {task.recurrence !== "none" && (
            <span className="inline-flex items-center gap-0.5">
              <Repeat className="size-3" /> {task.recurrence}
            </span>
          )}
          {task.source === "ai" && <Sparkles className="size-3 text-ai" aria-label="Created by AI" />}
          {task.tags.map((t) => (
            <TagChip key={t} name={t} color={color(t)} />
          ))}
        </div>
      </button>
    </div>
  );
}
