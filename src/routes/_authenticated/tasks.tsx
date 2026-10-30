import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  List,
  Plus,
  SearchX,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ListSkeleton, PageHeader, TagChip } from "@/components/common";
import { QuickAdd } from "@/components/quick-add";
import { TaskItem } from "@/components/task-item";
import { TaskToolbar, type TaskFilters } from "@/components/task-filters";
import { TaskBulkBar } from "@/components/task-bulk-bar";
import { SnoozeSheet, TaskDetailSheet, TaskMenuSheet } from "@/components/task-sheets";
import { TaskDialog, emptyDraft, taskToDraft, type TaskDraft } from "@/components/task-form";
import { useNotifyPrefs, useTags, useTasks, useToggleTask, useTz } from "@/lib/queries";
import { useTaskActions } from "@/lib/task-actions";
import {
  displayGroup,
  matchesSearch,
  sortTasks,
  type DisplayGroup,
  type SortKey,
  type Task,
  type TaskSource,
} from "@/lib/task-logic";
import { addDaysKey, dayKey, fmt, fromKeys } from "@/lib/tz";
import { parseTasksSearch, SOURCE_KEYS, type TasksSearch } from "@/lib/task-view";
import { csvToList, listToCsv, loadPref, savePref } from "@/lib/view-prefs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/tasks")({
  validateSearch: parseTasksSearch,
  head: () => ({
    meta: [
      { title: "Tasks — Daily Edge" },
      { name: "description", content: "Your tasks, organized into today, upcoming and someday." },
      { property: "og:title", content: "Tasks — Daily Edge" },
      {
        property: "og:description",
        content: "Your tasks, organized into today, upcoming and someday.",
      },
    ],
  }),
  component: TasksPage,
});

const GROUPS: { key: DisplayGroup; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "someday", label: "Someday" },
  { key: "done", label: "Done" },
];

/** Stable empty list, so `tasks ?? []` cannot invalidate the memos on every render. */
const NO_TASKS: Task[] = [];

const PREF_KEY = "tasks.view";
const COLLAPSE_KEY = "tasks.collapsed";

function TasksPage() {
  const tz = useTz();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: tasks, isLoading } = useTasks();
  const { data: tags = [] } = useTags();
  const { data: notify } = useNotifyPrefs();
  const toggle = useToggleTask(tz);
  const actions = useTaskActions(tz);

  const [dialog, setDialog] = useState<{ open: boolean; draft: TaskDraft }>({
    open: false,
    draft: emptyDraft(),
  });
  const [snoozing, setSnoozing] = useState<Task | null>(null);
  const [menuFor, setMenuFor] = useState<Task | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // parseSearch is the normalizer on both ends: whatever is merged in, the URL comes
  // out carrying only non-default values.
  const patch = useCallback(
    (p: Partial<TasksSearch>) =>
      navigate({ search: (prev) => parseTasksSearch({ ...prev, ...p }), replace: true }),
    [navigate],
  );

  // Replay the last view onto a bare /tasks, then keep it up to date. The URL wins when
  // there is one — arriving by a shared link must show that link's view, not yesterday's.
  const replayed = useRef(false);
  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    setCollapsed(loadPref<string[]>(COLLAPSE_KEY, []));
    if (window.location.search) return;
    const stored = loadPref<Partial<TasksSearch> | null>(PREF_KEY, null);
    if (stored) patch(stored);
  }, [patch]);

  // Skip the mount commit: the replay above navigates, and saving the pre-replay search
  // here would wipe the very preference we are about to restore.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    savePref(PREF_KEY, search);
  }, [search]);

  // ⌘F / "/" for search, ⌘I for the AI quick-add. ⌘K belongs to the command palette.
  useEffect(() => {
    const typing = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const fn = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (meta && e.key.toLowerCase() === "i") {
        e.preventDefault();
        quickRef.current?.focus();
      } else if (e.key === "/" && !meta && !typing(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && sel.size) {
        // An open popover or sheet gets the Escape first — clearing the selection
        // underneath it would be a second, invisible action on one keypress.
        // Where the key landed, not what is on screen: Radix flips its own
        // data-state to "closed" before this handler runs, so asking the DOM what is
        // open would clear the selection on the same Escape that shut the popover.
        // Focus is inside the layer while it is open, which is the honest signal.
        if (
          e.target instanceof Element &&
          e.target.closest('[data-radix-popper-content-wrapper],[role="dialog"]')
        )
          return;
        setSel(new Set());
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [sel.size]);

  const view = search.view ?? "list";
  const filters: TaskFilters = useMemo(
    () => ({
      sort: search.sort ?? "due",
      status: search.status ?? "todo",
      tags: csvToList(search.tags),
      tagMode: search.mode ?? "and",
      sources: csvToList(search.src).filter((s): s is TaskSource => SOURCE_KEYS.includes(s)),
      q: search.q ?? "",
    }),
    [search],
  );

  const setFilters = (p: Partial<TaskFilters>) =>
    patch({
      ...(p.sort !== undefined && { sort: p.sort }),
      ...(p.status !== undefined && { status: p.status }),
      ...(p.tags !== undefined && { tags: listToCsv(p.tags) }),
      ...(p.tagMode !== undefined && { mode: p.tagMode }),
      ...(p.sources !== undefined && { src: listToCsv(p.sources) }),
      ...(p.q !== undefined && { q: p.q || undefined }),
    });

  const all = tasks ?? NO_TASKS;

  /** Open-task counts per tag, which is what a filter chip should say. */
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) {
      if (t.status === "done") continue;
      for (const name of t.tags) m.set(name, (m.get(name) ?? 0) + 1);
    }
    return m;
  }, [all]);

  const filtered = useMemo(() => {
    const { status, tags: picked, tagMode: mode, sources, q } = filters;
    return all.filter((t) => {
      if (status !== "all" && t.status !== status) return false;
      if (sources.length && !sources.includes(t.source as TaskSource)) return false;
      if (picked.length) {
        const hit =
          mode === "and"
            ? picked.every((p) => t.tags.includes(p))
            : picked.some((p) => t.tags.includes(p));
        if (!hit) return false;
      }
      return matchesSearch(t, q);
    });
  }, [all, filters]);

  const groups = useMemo(() => {
    const m = new Map<DisplayGroup, Task[]>();
    for (const t of filtered) {
      const g = displayGroup(t, tz);
      m.set(g, [...(m.get(g) ?? []), t]);
    }
    return GROUPS.map((g) => ({ ...g, items: sortTasks(m.get(g.key) ?? [], filters.sort) })).filter(
      (g) => g.items.length > 0,
    );
  }, [filtered, tz, filters.sort]);

  const selectedTasks = useMemo(() => all.filter((t) => sel.has(t.id)), [all, sel]);
  const clearSel = () => setSel(new Set());

  const toggleCollapse = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    savePref(COLLAPSE_KEY, next);
  };

  const open = (t: Task) => setDialog({ open: true, draft: taskToDraft(t, tz) });
  const openNew = (date?: string) =>
    setDialog({ open: true, draft: { ...emptyDraft(), date: date ?? "" } });

  const morning = (notify?.morning_time ?? "09:00").slice(0, 5);

  const rowProps = (t: Task, overdue: boolean) => ({
    task: t,
    tz,
    tags,
    onToggle: (x: Task) => toggle.mutate(x),
    onOpen: setViewing,
    overdue,
    onSwipeSnooze: t.status === "done" ? undefined : setSnoozing,
    onMenu: setMenuFor,
    selected: sel.has(t.id),
    selectionActive: sel.size > 0,
    onSelect: (task: Task, on: boolean) =>
      setSel((prev) => {
        const next = new Set(prev);
        if (on) next.add(task.id);
        else next.delete(task.id);
        return next;
      }),
  });

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
                  onClick={() => patch({ view: v })}
                  aria-pressed={view === v}
                  className={cn(
                    "flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm transition-calm md:min-h-9",
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

      <div className="mt-4">
        <TaskToolbar
          filters={filters}
          set={setFilters}
          tags={tags}
          counts={counts}
          searchRef={searchRef}
          total={all.length}
          shown={filtered.length}
        />
      </div>

      <div className="mt-6">
        {isLoading ? (
          <ListSkeleton rows={6} />
        ) : view === "calendar" ? (
          <MonthCalendar
            tasks={filtered}
            tz={tz}
            month={search.month}
            onMonth={(m) => patch({ month: m })}
            tagColor={(n) => tags.find((t) => t.name === n)?.color}
            onOpen={setViewing}
            onNew={openNew}
          />
        ) : groups.length === 0 ? (
          all.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              action={{ label: "New task", onClick: () => openNew() }}
            >
              Nothing here yet. Describe a task above and the AI will fill in the details.
            </EmptyState>
          ) : (
            <EmptyState
              icon={SearchX}
              action={{
                label: "Clear filters",
                onClick: () => setFilters({ tags: [], sources: [], status: "todo", q: "" }),
              }}
            >
              No task matches these filters.
            </EmptyState>
          )
        ) : (
          <div className="space-y-6">
            {groups.map((g) => {
              const shut = collapsed.includes(g.key);
              return (
                <section key={g.key}>
                  <button
                    onClick={() => toggleCollapse(g.key)}
                    aria-expanded={!shut}
                    className="mb-2 flex min-h-11 w-full items-center gap-1.5 rounded-lg text-sm font-semibold transition-calm hover:text-foreground md:min-h-9"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        shut && "-rotate-90",
                      )}
                    />
                    <span className={cn(g.key === "overdue" && "text-overdue")}>{g.label}</span>
                    <span className="font-normal tabular-nums text-muted-foreground">
                      {g.items.length}
                    </span>
                  </button>
                  {!shut && (
                    <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                      {g.items.map((t) => (
                        <TaskItem key={t.id} {...rowProps(t, g.key === "overdue")} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <button
        onClick={() => openNew()}
        aria-label="New task"
        className="fixed bottom-24 right-5 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-calm active:scale-95 lg:hidden"
      >
        <Plus className="size-6" />
      </button>

      <TaskBulkBar
        selected={selectedTasks}
        tags={tags}
        tz={tz}
        onClear={clearSel}
        onComplete={async () => {
          await actions.complete(selectedTasks);
          clearSel();
        }}
        onTag={(name, on) => actions.tag(selectedTasks, name, on)}
        onReschedule={async (at, allDay) => {
          await actions.reschedule(selectedTasks, at, allDay);
        }}
        onDelete={async () => {
          const victims = selectedTasks;
          clearSel();
          await actions.remove(victims);
        }}
      />

      <SnoozeSheet
        task={snoozing}
        tz={tz}
        morningTime={morning}
        onClose={() => setSnoozing(null)}
        onPick={(t, at) => actions.snooze([t], at)}
      />

      <TaskMenuSheet
        task={menuFor}
        tz={tz}
        onClose={() => setMenuFor(null)}
        onEdit={open}
        onToggle={(t) => toggle.mutate(t)}
        onSnooze={setSnoozing}
        onDelete={(t) => actions.remove([t])}
      />

      <TaskDetailSheet
        task={viewing}
        tz={tz}
        tags={tags}
        onClose={() => setViewing(null)}
        onToggle={(t) => toggle.mutate(t)}
        onEdit={(t) => {
          setViewing(null);
          open(t);
        }}
      />

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
  month: monthProp,
  onMonth,
  tagColor,
  onOpen,
  onNew,
}: {
  tasks: Task[];
  tz: string;
  month: string | undefined;
  onMonth: (m: string) => void;
  tagColor: (n: string) => string | undefined;
  onOpen: (t: Task) => void;
  onNew: (date: string) => void;
}) {
  const today = dayKey(new Date(), tz);
  const month = /^\d{4}-\d{2}$/.test(monthProp ?? "") ? monthProp! : today.slice(0, 7);
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
    onMonth(d.toISOString().slice(0, 7));
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">
          {fmt(fromKeys(first, "12:00", tz), tz, { month: "long", year: "numeric" })}
        </h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-lg"
            onClick={() => shift(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-10 rounded-lg"
            onClick={() => onMonth(today.slice(0, 7))}
          >
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-lg"
            onClick={() => shift(1)}
            aria-label="Next month"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
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
                      className={cn(
                        "w-full truncate rounded-md px-1 text-[10px] md:text-[11px]",
                        t.status === "done" && "line-through opacity-60",
                      )}
                    />
                  </button>
                ))}
                {items.length > 3 && (
                  <p className="px-1 text-[10px] text-muted-foreground">+{items.length - 3} more</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
