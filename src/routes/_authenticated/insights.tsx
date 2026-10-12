import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { Clock, Newspaper, Sparkles, Target } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AppShell } from "@/components/app-shell";
import { Card, PageHeader } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompletions, useDigests, useTasks, useTz } from "@/lib/queries";
import { onTimeRate } from "@/lib/task-logic";
import { addDaysKey, dayKey, fmt, fromKeys } from "@/lib/tz";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({
    meta: [
      { title: "Insights — Daily Edge" },
      { name: "description", content: "How much reading AI saved you and how you're keeping up with tasks." },
      { property: "og:title", content: "Insights — Daily Edge" },
      { property: "og:description", content: "How much reading AI saved you and how you're keeping up with tasks." },
    ],
  }),
  component: Insights,
});

const MIN_PER_ARTICLE = 3;

function Insights() {
  const tz = useTz();
  const digests = useDigests();
  const tasks = useTasks();
  const comps = useCompletions();

  const scanned = (digests.data ?? []).reduce((s, d) => s + d.sources_scanned, 0);
  const minutes = scanned * MIN_PER_ARTICLE;
  const aiTasks = (tasks.data ?? []).filter((t) => t.source === "ai").length;
  const rate = onTimeRate(comps.data ?? []);

  const chart = useMemo(() => {
    const today = dayKey(new Date(), tz);
    const counts = new Map<string, number>();
    for (const c of comps.data ?? []) {
      const k = dayKey(c.completed_at, tz);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return Array.from({ length: 30 }, (_, i) => {
      const k = addDaysKey(today, i - 29);
      return { day: fmt(fromKeys(k, "12:00", tz), tz, { day: "numeric", month: "short" }), count: counts.get(k) ?? 0 };
    });
  }, [comps.data, tz]);

  const stats = [
    { icon: Newspaper, label: "Articles scanned", value: scanned.toLocaleString("en-IN"), loading: digests.isLoading },
    {
      icon: Clock,
      label: "Reading time saved",
      value: minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`,
      loading: digests.isLoading,
    },
    { icon: Sparkles, label: "Tasks created by AI", value: String(aiTasks), loading: tasks.isLoading, ai: true },
    { icon: Target, label: "On-time completion", value: rate === null ? "—" : `${rate}%`, loading: comps.isLoading },
  ];

  return (
    <AppShell>
      <PageHeader title="Insights" subtitle="Reading time saved assumes 3 minutes per article." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} ai={s.ai} className="p-5">
            <s.icon className={s.ai ? "size-4 text-ai" : "size-4 text-muted-foreground"} />
            {s.loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">{s.value}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-6 p-5">
        <h2 className="mb-4 text-sm font-semibold">Completions — last 30 days</h2>
        {comps.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ left: -24, right: 4 }}>
                <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} interval={4} stroke="var(--muted-foreground)" />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
                <Tooltip
                  cursor={{ fill: "var(--accent)" }}
                  contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }}
                />
                <Bar dataKey="count" name="Completed" fill="var(--primary)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
