import { useRef, useState } from "react";
import { Check, Clock, Repeat, Sparkles, Terminal, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { absoluteDue, fmt, dayKey, relativeDue } from "@/lib/tz";
import { repoContextLine, type Task } from "@/lib/task-logic";
import type { Tag } from "@/lib/queries";
import { TagChip } from "./common";
import { Checkbox } from "@/components/ui/checkbox";

export function dueLabel(task: Task, tz: string) {
  if (!task.due_at) return null;
  const today = dayKey(new Date(), tz);
  const k = dayKey(task.due_at, tz);
  const date = k === today ? "Today" : fmt(task.due_at, tz, { day: "numeric", month: "short" });
  if (task.all_day) return date;
  return `${date} · ${fmt(task.due_at, tz, { hour: "numeric", minute: "2-digit" })}`;
}

/** Where a task came from, for a row that has no room to spell it out. */
const SOURCE_MARKS = {
  ai: { icon: Sparkles, label: "Created by AI", tone: "text-ai" },
  mcp: { icon: Terminal, label: "Created over MCP", tone: "text-ai" },
  telegram: { icon: Send, label: "Captured from Telegram", tone: "text-muted-foreground" },
} as const;

function SourceMark({ source }: { source: string }) {
  const mark = SOURCE_MARKS[source as keyof typeof SOURCE_MARKS];
  if (!mark) return null; // "manual" is the default; an icon for it would be noise
  return <mark.icon className={cn("size-3 shrink-0", mark.tone)} aria-label={mark.label} />;
}

/**
 * Priority as a hairline on the left edge rather than a word or a coloured title.
 * High and medium get a bar; low gets nothing, because three visible levels on twenty
 * rows is just stripes.
 */
function PriorityBar({ priority, muted }: { priority: string; muted: boolean }) {
  if (priority === "low") return <span aria-hidden className="w-[3px] shrink-0" />;
  return (
    <span
      aria-label={`${priority} priority`}
      className={cn(
        "w-[3px] shrink-0 self-stretch rounded-full",
        priority === "high" ? "bg-overdue" : "bg-warn",
        muted && "opacity-30",
      )}
    />
  );
}

const SWIPE_TRIGGER = 72; // px of travel that commits the gesture
const LONG_PRESS_MS = 450;

export function TaskItem({
  task,
  tz,
  tags,
  onToggle,
  onOpen,
  overdue,
  onSwipeSnooze,
  onMenu,
  selected,
  onSelect,
  selectionActive,
}: {
  task: Task;
  tz: string;
  tags: Tag[];
  onToggle: (t: Task) => void;
  onOpen?: ((t: Task) => void) | undefined;
  overdue?: boolean | undefined;
  /** Mobile: swipe left. Omit and the row does not swipe that way. */
  onSwipeSnooze?: ((t: Task) => void) | undefined;
  /** Long press on mobile, right click on desktop. */
  onMenu?: ((t: Task) => void) | undefined;
  /** Passing onSelect turns the checkbox on (desktop bulk selection). */
  selected?: boolean | undefined;
  onSelect?: ((t: Task, on: boolean) => void) | undefined;
  /** True once anything is selected, which pins every checkbox visible. */
  selectionActive?: boolean | undefined;
}) {
  const done = task.status === "done";
  const color = (n: string) => tags.find((t) => t.name === n)?.color;
  const context = repoContextLine(task.notes);
  const snoozed = task.snoozed_until && new Date(task.snoozed_until) > new Date();

  // --- gestures -------------------------------------------------------------
  // One pointer handler set, because a row has to survive being scrolled past: the
  // swipe only engages once horizontal travel beats vertical, and the long press dies
  // the moment the finger moves at all.
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<"none" | "x" | "y">("none");
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const clearPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    axis.current = "none";
    if (onMenu) {
      press.current = setTimeout(() => {
        suppressClick.current = true;
        onMenu(task);
      }, LONG_PRESS_MS);
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t || !start.current) return;
    const mx = t.clientX - start.current.x;
    const my = t.clientY - start.current.y;
    if (Math.abs(mx) > 6 || Math.abs(my) > 6) clearPress();
    if (axis.current === "none") {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      axis.current = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    }
    if (axis.current !== "x") return;
    // Right swipe completes; left swipe snoozes, but only if there is a sheet to open.
    const allowed = mx > 0 ? !done : !!onSwipeSnooze;
    setDx(allowed ? Math.max(-140, Math.min(140, mx)) : 0);
  };

  const onTouchEnd = () => {
    clearPress();
    const travel = dx;
    setDx(0);
    start.current = null;
    if (axis.current !== "x") return;
    axis.current = "none";
    if (Math.abs(travel) < SWIPE_TRIGGER) return;
    suppressClick.current = true;
    if (travel > 0 && !done) onToggle(task);
    else if (travel < 0) onSwipeSnooze?.(task);
  };

  const guard = (fn: () => void) => () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    fn();
  };

  return (
    <div className="relative overflow-hidden">
      {/* What the swipe is about to do, revealed under the row. */}
      {dx !== 0 && (
        <div aria-hidden className="absolute inset-0 flex items-center justify-between px-5">
          <span className={cn("flex items-center gap-1.5 text-xs font-medium text-success")}>
            <Check className="size-4" /> Complete
          </span>
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Snooze <Clock className="size-4" />
          </span>
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                onMenu(task);
              }
            : undefined
        }
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={cn(
          "group flex items-stretch gap-2 bg-card px-2 py-2.5 transition-calm hover:bg-accent/60",
          dx !== 0 && "transition-none",
          selected && "bg-ai-soft hover:bg-ai-soft",
        )}
      >
        <PriorityBar priority={task.priority} muted={done} />
        {/* Hidden until you reach for it: twenty permanent checkboxes next to twenty
            completion circles is two controls that look like the same control. */}
        {onSelect && (
          <span
            className={cn(
              "hidden shrink-0 items-center pl-1 opacity-0 transition-calm focus-within:opacity-100 group-hover:opacity-100 lg:flex",
              (selected || selectionActive) && "opacity-100",
            )}
          >
            <Checkbox
              checked={!!selected}
              onCheckedChange={(v) => onSelect(task, v === true)}
              aria-label={`Select ${task.title}`}
            />
          </span>
        )}
        <button
          onClick={guard(() => onToggle(task))}
          aria-label={done ? "Mark as not done" : "Mark as done"}
          className="-my-2.5 flex size-11 shrink-0 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border-[1.5px] transition-calm",
              done
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground/40 hover:border-primary",
              task.priority === "high" && !done && "border-overdue",
            )}
          >
            {done && <Check className="size-3" />}
          </span>
        </button>
        <button
          onClick={guard(() => onOpen?.(task))}
          className="min-w-0 flex-1 rounded-lg py-0.5 text-left focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className={cn("text-sm", done && "text-muted-foreground line-through")}>
            {task.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {task.due_at && (
              <span
                title={absoluteDue(task.due_at, tz, task.all_day)}
                className={cn("tabular-nums", overdue && "font-medium text-overdue")}
              >
                {relativeDue(task.due_at, tz, task.all_day)}
              </span>
            )}
            {task.recurrence !== "none" && (
              <span className="inline-flex items-center gap-0.5">
                <Repeat className="size-3" /> {task.recurrence}
              </span>
            )}
            {snoozed && (
              <span
                title={`Snoozed until ${absoluteDue(task.snoozed_until!, tz)}`}
                className="inline-flex items-center gap-0.5"
              >
                <Clock className="size-3" /> snoozed
              </span>
            )}
            <SourceMark source={task.source} />
            {task.tags.map((t) => (
              <TagChip key={t} name={t} color={color(t)} />
            ))}
          </div>
          {/* MCP writes the repo, the branch and a "Next:" step into notes for a reader
              who no longer has the conversation open. One line of it belongs in the row. */}
          {context && (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
              {context}
            </p>
          )}
        </button>
      </div>
    </div>
  );
}
