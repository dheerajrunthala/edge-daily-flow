import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { CheckCircle2, GitBranch, MailOpen, Newspaper, Target } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ComponentProps, ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Card, EmptyState, PageHeader } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAiEvents,
  useCompletions,
  useDigests,
  useNewsCounts,
  useTasks,
  useToolCalls,
  useTz,
} from "@/lib/queries";
import { onTimeRate } from "@/lib/task-logic";
import {
  completionsByDay,
  INSIGHTS_DAYS,
  inWindow,
  kindSpend,
  num,
  readShare,
  scannedArticles,
  SURFACE_LABELS,
  surfaceSeries,
  tasksBySource,
  windowDays,
  windowStart,
} from "@/lib/insights";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({
    meta: [
      { title: "Insights — Daily Edge" },
      {
        name: "description",
        content: "What your briefs, your agents and your tasks actually did this month.",
      },
      { property: "og:title", content: "Insights — Daily Edge" },
      {
        property: "og:description",
        content: "What your briefs, your agents and your tasks actually did this month.",
      },
    ],
  }),
  component: Insights,
});

/**
 * Colour by surface, fixed. The slot a door gets never depends on how busy it was, so
 * filtering the chart down to one surface does not repaint it.
 */
const SURFACE_FILL: Record<string, string> = {
  mcp: "var(--viz-1)",
  chat: "var(--viz-2)",
  voice: "var(--viz-3)",
  telegram: "var(--viz-4)",
  planner: "var(--viz-5)",
};

function fillFor(surface: string): string {
  return SURFACE_FILL[surface] ?? "var(--viz-other)";
}

/** Hairline, one step off the surface, and solid — the grid is not data. */
const GRID = "var(--border)";
const AXIS = { tickLine: false, axisLine: false, fontSize: 11, stroke: "var(--muted-foreground)" };

function Insights() {
  const tz = useTz();
  // One window for the whole page, computed once: every card below counts the same days,
  // and `since` is what the three windowed queries send as their lower bound.
  const days = useMemo(() => windowDays(tz), [tz]);
  const since = useMemo(() => windowStart(tz), [tz]);

  const digests = useDigests();
  const tasks = useTasks();
  const comps = useCompletions();
  const calls = useToolCalls(since);
  const events = useAiEvents(since);
  const news = useNewsCounts(since);

  const scanned = useMemo(() => scannedArticles(digests.data ?? [], days), [digests.data, days]);
  const surf = useMemo(() => surfaceSeries(calls.data ?? [], days, tz), [calls.data, days, tz]);
  const spend = useMemo(() => kindSpend(events.data ?? [], days, tz), [events.data, days, tz]);
  const sources = useMemo(() => tasksBySource(tasks.data ?? [], days, tz), [tasks.data, days, tz]);
  const completions = useMemo(
    () => completionsByDay(comps.data ?? [], days, tz),
    [comps.data, days, tz],
  );
  const rate = useMemo(
    () => onTimeRate(inWindow(comps.data ?? [], (c) => c.completed_at, days, tz)),
    [comps.data, days, tz],
  );

  const delivered = news.data?.delivered ?? 0;
  const opened = news.data?.opened ?? 0;
  const share = readShare(opened, delivered);
  const taskTotal = sources.reduce((s, r) => s + r.count, 0);
  const spendTotal = spend.reduce((s, r) => s + r.total, 0);

  const loading =
    digests.isLoading ||
    tasks.isLoading ||
    comps.isLoading ||
    calls.isLoading ||
    events.isLoading ||
    news.isLoading;

  // A new account has no digests, no tasks and no agent calls, and five empty cards is a
  // worse answer than one sentence.
  const nothing =
    !loading &&
    scanned === 0 &&
    delivered === 0 &&
    taskTotal === 0 &&
    surf.total === 0 &&
    spend.length === 0 &&
    completions.every((d) => d.count === 0);

  return (
    <AppShell>
      <PageHeader
        title="Insights"
        subtitle={`Counted from your own rows, over the last ${INSIGHTS_DAYS} days.`}
      />

      {nothing ? (
        <EmptyState icon={Newspaper}>
          Nothing to measure yet. Your first brief arrives tomorrow morning, and this page fills in
          from it.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              icon={Newspaper}
              value={num(scanned)}
              label="Articles read by the pipeline"
              loading={digests.isLoading}
            />
            <Stat
              icon={MailOpen}
              value={share === null ? "—" : `${share}%`}
              label={`Stories you opened — ${num(opened)} of ${num(delivered)}`}
              loading={news.isLoading}
            />
            <Stat
              icon={GitBranch}
              value={num(news.data?.followups ?? 0)}
              label="Stories linked to an earlier one"
              loading={news.isLoading}
            />
            <Stat
              icon={Target}
              value={rate === null ? "—" : `${rate}%`}
              label="Tasks completed on time"
              loading={comps.isLoading}
            />
          </div>

          <Panel
            className="mt-6"
            title="Agent activity by surface"
            note={
              surf.failed > 0
                ? `${num(surf.total)} tool calls, ${num(surf.failed)} of them failed`
                : `${num(surf.total)} tool calls`
            }
            loading={calls.isLoading}
            empty={
              surf.total === 0 && (
                <EmptyState icon={Target}>
                  No agent has called a tool in the last 30 days. Connect an MCP client in Settings,
                  or turn the planner on.
                </EmptyState>
              )
            }
            legend={surf.active.map((s) => ({
              fill: fillFor(s),
              label: SURFACE_LABELS[s] ?? s,
              value: num(surf.totals[s] ?? 0),
            }))}
          >
            <BarChart data={surf.data} margin={{ left: -22, right: 4, top: 4 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="day" interval={4} {...AXIS} />
              <YAxis allowDecimals={false} tickFormatter={num} {...AXIS} />
              <Tooltip cursor={{ fill: "var(--accent)" }} content={<VizTooltip />} />
              {surf.active.map((s, i) => (
                <Bar
                  key={s}
                  dataKey={s}
                  name={SURFACE_LABELS[s] ?? s}
                  stackId="calls"
                  fill={fillFor(s)}
                  maxBarSize={24}
                  // The stroke is the card colour, so it reads as the 2px gap between
                  // stacked segments rather than as ink — recharts has no gap of its own.
                  stroke="var(--card)"
                  strokeWidth={surf.active.length > 1 ? 2 : 0}
                  // Only the top of the stack is rounded; everything below it stays
                  // square so the segments still read as one bar off one baseline.
                  radius={i === surf.active.length - 1 ? [4, 4, 0, 0] : 0}
                />
              ))}
            </BarChart>
          </Panel>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Panel
              title="Where your tasks came from"
              note={`${num(taskTotal)} created`}
              loading={tasks.isLoading}
              empty={
                taskTotal === 0 && (
                  <EmptyState icon={CheckCircle2}>
                    No tasks created in the last 30 days — by you or by anything else.
                  </EmptyState>
                )
              }
            >
              {/* No gridlines: every bar carries its own value at the tip, and a direct
                  label beats a line the reader has to trace back to an axis. */}
              <BarChart data={sources} layout="vertical" margin={{ left: 4, right: 36 }}>
                <XAxis type="number" allowDecimals={false} hide />
                <YAxis type="category" dataKey="label" width={132} {...AXIS} />
                <Tooltip cursor={{ fill: "var(--accent)" }} content={<VizTooltip />} />
                <Bar
                  dataKey="count"
                  name="Tasks"
                  fill="var(--viz-1)"
                  maxBarSize={24}
                  radius={[0, 4, 4, 0]}
                >
                  <LabelList
                    dataKey="count"
                    position="right"
                    className="fill-muted-foreground"
                    fontSize={11}
                  />
                </Bar>
              </BarChart>
            </Panel>

            <Panel
              title="Model spend by job"
              note={`${num(spendTotal)} tokens`}
              loading={events.isLoading}
              empty={
                spend.length === 0 && (
                  <EmptyState icon={Target}>
                    No model call in the last 30 days is booked to your account.
                  </EmptyState>
                )
              }
              legend={[
                { fill: "var(--viz-in)", label: "Input", value: num(sum(spend, "input")) },
                { fill: "var(--viz-out)", label: "Output", value: num(sum(spend, "output")) },
              ]}
            >
              <BarChart data={spend} layout="vertical" margin={{ left: 4, right: 60 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={118} {...AXIS} />
                <Tooltip cursor={{ fill: "var(--accent)" }} content={<VizTooltip />} />
                <Bar
                  dataKey="input"
                  name="Input"
                  stackId="tokens"
                  fill="var(--viz-in)"
                  maxBarSize={24}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
                <Bar
                  dataKey="output"
                  name="Output"
                  stackId="tokens"
                  fill="var(--viz-out)"
                  maxBarSize={24}
                  stroke="var(--card)"
                  strokeWidth={2}
                  radius={[0, 4, 4, 0]}
                >
                  {/* The stack's own total at the tip — an interior segment has no free
                      end to label, so the legend and the tooltip carry the split. */}
                  <LabelList
                    dataKey="total"
                    position="right"
                    formatter={num}
                    className="fill-muted-foreground"
                    fontSize={11}
                  />
                </Bar>
              </BarChart>
            </Panel>
          </div>

          <Panel
            className="mt-6"
            title="Tasks completed"
            note={`${num(completions.reduce((s, d) => s + d.count, 0))} completed`}
            loading={comps.isLoading}
          >
            <BarChart data={completions} margin={{ left: -22, right: 4, top: 4 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="day" interval={4} {...AXIS} />
              <YAxis allowDecimals={false} tickFormatter={num} {...AXIS} />
              <Tooltip cursor={{ fill: "var(--accent)" }} content={<VizTooltip />} />
              <Bar
                dataKey="count"
                name="Completed"
                fill="var(--viz-1)"
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </Panel>
        </>
      )}
    </AppShell>
  );
}

function sum(rows: { input: number; output: number }[], key: "input" | "output"): number {
  return rows.reduce((s, r) => s + r[key], 0);
}

function Stat({
  icon: Icon,
  value,
  label,
  loading,
}: {
  icon: typeof Newspaper;
  value: string;
  label: string;
  loading: boolean;
}) {
  return (
    <Card className="p-5">
      <Icon className="size-4 text-muted-foreground" />
      {loading ? (
        <Skeleton className="mt-3 h-8 w-20" />
      ) : (
        <p className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">{value}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </Card>
  );
}

type LegendKey = { fill: string; label: string; value: string };

/**
 * One card for one chart: title, a counted note, the legend, and the plot.
 *
 * The legend carries each series' own total, which is also what makes the lighter slots
 * legible — three of the five surface colours sit under 3:1 against the card in light
 * mode, so identity and value are both stated in text rather than left to the hue.
 */
function Panel({
  title,
  note,
  legend,
  loading,
  empty,
  height = "h-64",
  className,
  children,
}: {
  title: string;
  note?: string;
  legend?: LegendKey[];
  loading: boolean;
  empty?: ReactNode | false;
  height?: string;
  className?: string;
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  return (
    <Card className={`p-5 ${className ?? ""}`}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="text-xs tabular-nums text-muted-foreground">{note}</p>}
      </div>
      {legend && !loading && !empty && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
          {legend.map((k) => (
            <li key={k.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="size-2 rounded-full"
                style={{ background: k.fill }}
                aria-hidden="true"
              />
              {k.label}
              <span className="font-medium tabular-nums text-foreground">{k.value}</span>
            </li>
          ))}
        </ul>
      )}
      {loading ? (
        <Skeleton className={`${height} w-full`} />
      ) : empty ? (
        empty
      ) : (
        <div className={height}>
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/**
 * The hover layer, shared by every chart here.
 *
 * Zero rows are dropped: a thirty-day stack with five surfaces would otherwise list four
 * "0"s under the one number the reader is pointing at. Text wears text tokens and the
 * colour is carried by the dot beside it.
 */
function VizTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; fill?: string }[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => (p.value ?? 0) > 0);
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-soft">
      {label !== undefined && label !== "" && (
        <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      )}
      <ul className="space-y-0.5">
        {rows.map((p) => (
          <li key={p.name} className="flex items-center gap-2 text-muted-foreground">
            <span
              className="size-2 rounded-full"
              style={{ background: p.fill ?? p.color }}
              aria-hidden="true"
            />
            {p.name}
            <span className="ml-auto font-medium tabular-nums text-popover-foreground">
              {num(p.value ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
