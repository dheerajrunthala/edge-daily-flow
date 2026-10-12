import { ArrowUpDown, Check, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SORTS, TASK_SOURCES, type SortKey, type TaskSource } from "@/lib/task-logic";
import type { Tag } from "@/lib/queries";
import { TagChip } from "./common";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type TaskFilters = {
  sort: SortKey;
  status: "todo" | "done" | "all";
  tags: string[];
  tagMode: "and" | "or";
  sources: TaskSource[];
  q: string;
};

const STATUS: { key: TaskFilters["status"]; label: string }[] = [
  { key: "todo", label: "Open" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

/**
 * One toolbar for both widths rather than two layouts to keep in step: everything is a
 * chip or a dropdown, the chip rows scroll horizontally at 375px, and nothing is hidden
 * behind a breakpoint — a filter you cannot reach on your phone is a filter you stop
 * trusting is off.
 */
export function TaskToolbar({
  filters,
  set,
  tags,
  counts,
  searchRef,
  total,
  shown,
}: {
  filters: TaskFilters;
  set: (patch: Partial<TaskFilters>) => void;
  tags: Tag[];
  /** Open-task count per tag name, for the chip. */
  counts: Map<string, number>;
  searchRef?: React.Ref<HTMLInputElement>;
  total: number;
  shown: number;
}) {
  const sortLabel = SORTS.find((s) => s.key === filters.sort)?.label ?? "Due date";
  const active =
    filters.tags.length > 0 ||
    filters.sources.length > 0 ||
    filters.status !== "todo" ||
    !!filters.q;

  const toggleTag = (name: string) =>
    set({
      tags: filters.tags.includes(name)
        ? filters.tags.filter((t) => t !== name)
        : [...filters.tags, name],
    });

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search tasks"
            aria-label="Search tasks"
            className="h-11 rounded-xl pl-9 pr-9"
          />
          {filters.q && (
            <button
              onClick={() => set({ q: "" })}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-11 shrink-0 rounded-xl px-3 font-normal">
              <ArrowUpDown className="size-4" />
              <span className="hidden sm:inline">{sortLabel}</span>
              <span className="sr-only sm:hidden">Sort: {sortLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filters.sort}
              onValueChange={(v) => set({ sort: v as SortKey })}
            >
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.key} value={s.key}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "h-11 shrink-0 rounded-xl px-3 font-normal",
                filters.sources.length > 0 && "border-primary text-primary",
              )}
            >
              <SlidersHorizontal className="size-4" />
              <span className="hidden sm:inline">
                {filters.sources.length ? `${filters.sources.length} source` : "Source"}
              </span>
              <span className="sr-only sm:hidden">Filter by source</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Created from</DropdownMenuLabel>
            {TASK_SOURCES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.key}
                checked={filters.sources.includes(s.key)}
                onCheckedChange={(on) =>
                  set({
                    sources: on
                      ? [...filters.sources, s.key]
                      : filters.sources.filter((x) => x !== s.key),
                  })
                }
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            {filters.sources.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => set({ sources: [] })}>
                  Any source
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Status, and — only once it can mean something — how to combine two tags. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-muted p-1">
          {STATUS.map((s) => (
            <button
              key={s.key}
              onClick={() => set({ status: s.key })}
              aria-pressed={filters.status === s.key}
              className={cn(
                "min-h-11 rounded-lg px-3 text-sm transition-calm md:min-h-9",
                filters.status === s.key
                  ? "bg-card font-medium shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {filters.tags.length > 1 && (
          <div className="inline-flex rounded-xl bg-muted p-1">
            {(["and", "or"] as const).map((m) => (
              <button
                key={m}
                onClick={() => set({ tagMode: m })}
                aria-pressed={filters.tagMode === m}
                title={m === "and" ? "Has every selected tag" : "Has any selected tag"}
                className={cn(
                  "min-h-11 rounded-lg px-3 text-xs font-medium uppercase tracking-wide transition-calm md:min-h-9",
                  filters.tagMode === m
                    ? "bg-card shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {active && (
          <button
            onClick={() => set({ tags: [], sources: [], status: "todo", q: "" })}
            className="inline-flex min-h-11 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-calm hover:bg-accent hover:text-foreground md:min-h-9"
          >
            <X className="size-3" /> Clear
          </button>
        )}
        {active && (
          <span className="text-xs text-muted-foreground">
            {shown} of {total}
          </span>
        )}
      </div>

      {tags.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none md:-mx-1 md:px-1">
          {tags.map((t) => {
            const on = filters.tags.includes(t.name);
            const n = counts.get(t.name) ?? 0;
            return (
              <button
                key={t.id}
                onClick={() => toggleTag(t.name)}
                aria-pressed={on}
                className={cn(
                  "shrink-0 rounded-full ring-offset-2 ring-offset-background transition-calm focus-visible:ring-2 focus-visible:ring-ring",
                  on && "ring-2 ring-primary",
                )}
              >
                <TagChip
                  name={t.name}
                  color={t.color}
                  className="min-h-11 gap-1.5 px-3 py-1.5 text-xs md:min-h-9"
                >
                  {on && <Check className="size-3" />}
                  <span className="opacity-60">{n}</span>
                </TagChip>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
