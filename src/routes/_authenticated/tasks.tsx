import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, List, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ListSkeleton, PageHeader, SectionTitle, TagChip } from "@/components/common";
import { QuickAdd } from "@/components/quick-add";
import { TaskItem } from "@/components/task-item";
import { TaskDialog, emptyDraft, taskToDraft, type TaskDraft } from "@/components/task-form";
import { useTags, useTasks, useToggleTask, useTz } from "@/lib/queries";
import { taskGroup, type Group, type Task } from "@/lib/task-logic";
import { addDaysKey, dayKey, fmt, fromKeys } from "@/lib/tz";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks — Daily Edge" },
      { name: "description", content: "Your tasks, organized into today, upcoming and someday." },
      { property: "og:title", content: "Tasks — Daily Edge" },
      { property: "og:description", content: "Your tasks, organized into today, upcoming and someday." },
    ],
  }),
  component: TasksPage,
});

const GROUPS: { key: Group; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "someday", label: "Someday" },
];

function TasksPage() {
  const tz = useTz();
  const { data: tasks, isLoading } = useTasks();
  const { data: tags = [] } = useTags();
  const toggle = useToggleTask(tz);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [tag, setTag] = useState("all");
  const [status, setStatus] = useState<"todo" | "done" | "all">("todo");
  const [dialog, setDialog] = useState<{ open: boolean; draft: TaskDraft }>({ open: false, draft: emptyDraft() });
  const quickRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        quickRef.current?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  const filtered = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => (tag === "all" || t.tags.includes(tag)) && (status === "all" || t.status === status),
      ),
    [tasks, tag, status],
  );

  const open = (t: Task) => setDialog({ open: true, draft: taskToDraft(t, tz) });
  const openNew = (date?: string) => setDialog({ open: true, draft: { ...emptyDraft(), date: date ?? "" } });

  return (
    <AppShell>
      <PageHeader
        title="Tasks"
        action={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl bg-muted p-1">
              {(["list", "calendar"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    "flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm transition-calm",
                    view === v ? "bg-card font-medium shadow-soft" : "text-muted-foreground",
                  )}
                >
                  {v === "list" ? <List className="size-4" /> : <CalendarDays className="size-4" />}
                  {v === "list" ? "List" : "Calendar"}
                </button>
              ))}
            </div>
            <Button className="hidden rounded-xl lg:inline-flex" onClick={() => openNew()}>
              <Plus /> New task
            </Button>
          </div>
        }
      />

      <QuickAdd ref={quickRef} tz={tz} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Select value={tag} onValueChange={setTag}>
          <SelectTrigger className="h-10 w-40 rounded-xl"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tags</SelectItem>
            {tags.map((t) => (
              <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="h-10 w-36 rounded-xl"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todo">To do</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-6">
        {isLoading ? (
          <ListSkeleton rows={6} />
        ) : view === "list" ? (
          filtered.length === 0 ? (
            <EmptyState icon={CheckCircle2}>Nothing here. Add a task above, or try a different filter.</EmptyState>
          ) : (
            <div className="space-y-8">
              {GROUPS.map((g) => {
                const items = filtered.filter((t) => taskGroup(t, tz) === g.key);
                if (!items.length) return null;
                return (
                  <section key={g.key}>
                    <SectionTitle tone={g.key === "overdue" ? "overdue" : undefined}>
                      {g.label} <span className="font-normal text-muted-foreground">{items.length}</span>
                    </SectionTitle>
                    <div className="divide-y divide-border rounded-2xl border border-border bg-card px-2">
                      {items.map((t) => (
                        <TaskItem
                          key={t.id}
                          task={t}
                          tz={tz}
                          tags={tags}
                          onToggle={(x) => toggle.mutate(x)}
                          onOpen={open}
                          overdue={g.key === "overdue" && t.status !== "done"}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )
        ) : (
          <MonthCalendar tasks={filtered} tz={tz} tagColor={(n) => tags.find((t) => t.name === n)?.color} onOpen={open} onNew={openNew} />
        )}
      </div>

      <button
        onClick={() => openNew()}
        aria-label="New task"
        className="fixed bottom-20 right-5 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-calm active:scale-95 lg:hidden"
      >
        <Plus className="size-6" />
      </button>

      <TaskDialog
        open={dialog.open}
        onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
        initial={dialog.draft}
        tz={tz}
      />
    </AppShell>
  );
}

function MonthCalendar({
  tasks,
  tz,
  tagColor,
  onOpen,
  onNew,
}: {
  tasks: Task[];
  tz: string;
  tagColor: (n: string) => string | undefined;
  onOpen: (t: Task) => void;
  onNew: (date: string) => void;
}) {
  const today = dayKey(new Date(), tz);
  const [month, setMonth] = useState(today.slice(0, 7)); // YYYY-MM
  const [y = 2026, m = 1] = month.split("-").map(Number);
  const first = `${month}-01`;
  const startDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const gridStart = addDaysKey(first, -startDow);
  const days = Array.from({ length: 42 }, (_, i) => addDaysKey(gridStart, i));
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.due_at) continue;
      const k = dayKey(t.due_at, tz);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return map;
  }, [tasks, tz]);
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{fmt(fromKeys(first, "12:00", tz), tz, { month: "long", year: "numeric" })}</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" className="size-10 rounded-lg" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="sm" className="h-10 rounded-lg" onClick={() => setMonth(today.slice(0, 7))}>
            Today
          </Button>
          <Button variant="ghost" size="icon" className="size-10 rounded-lg" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-2">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-border">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const inMonth = d.startsWith(month);
          return (
            <div
              key={d}
              onDoubleClick={() => onNew(d)}
              className={cn("min-h-16 bg-card p-1 md:min-h-24 md:p-1.5", !inMonth && "bg-muted/40")}
            >
              <div
                className={cn(
                  "mb-1 flex size-6 items-center justify-center rounded-full text-xs",
                  d === today && "bg-primary font-semibold text-primary-foreground",
                  !inMonth && "text-muted-foreground",
                )}
              >
                {Number(d.slice(8))}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((t) => (
                  <button key={t.id} onClick={() => onOpen(t)} className="block w-full text-left">
                    <TagChip
                      name={t.title}
                      color={tagColor(t.tags[0] ?? "") ?? "slate"}
                      className={cn("w-full truncate rounded-md px-1 text-[10px] md:text-[11px]", t.status === "done" && "line-through opacity-60")}
                    />
                  </button>
                ))}
                {items.length > 3 && <p className="px-1 text-[10px] text-muted-foreground">+{items.length - 3} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
