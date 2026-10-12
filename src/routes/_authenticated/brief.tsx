import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, Cake, CheckCircle2, Newspaper, Sun } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AiMark, Card, EmptyState, ListSkeleton, SectionTitle } from "@/components/common";
import { TaskItem } from "@/components/task-item";
import { NewsCard } from "@/components/news-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigests, useNewsItems, useProfile, useTags, useTasks, useToggleTask, useTz } from "@/lib/queries";
import { taskGroup, withinNextDays } from "@/lib/task-logic";
import { fmt, greeting } from "@/lib/tz";

export const Route = createFileRoute("/_authenticated/brief")({
  head: () => ({
    meta: [
      { title: "Your brief — Daily Edge" },
      { name: "description", content: "Today's tasks, birthdays and top headlines at a glance." },
      { property: "og:title", content: "Your brief — Daily Edge" },
      { property: "og:description", content: "Today's tasks, birthdays and top headlines at a glance." },
    ],
  }),
  component: Brief,
});

function Brief() {
  const tz = useTz();
  const { data: profile } = useProfile();
  const { data: tasks, isLoading } = useTasks();
  const { data: tags = [] } = useTags();
  const { data: digests, isLoading: dLoading } = useDigests();
  const latest = digests?.find((d) => d.status === "ready") ?? digests?.[0];
  const { data: items, isLoading: iLoading } = useNewsItems(latest?.id);
  const toggle = useToggleTask(tz);

  const open = (tasks ?? []).filter((t) => t.status === "todo");
  const today = open.filter((t) => taskGroup(t, tz) === "today");
  const overdue = open.filter((t) => taskGroup(t, tz) === "overdue");
  const birthdays = open.filter((t) => t.tags.includes("Birthday") && withinNextDays(t.due_at, 7, tz));
  const first = profile?.full_name?.split(" ")[0];

  const list = (arr: typeof open, isOverdue?: boolean) => (
    <div className="divide-y divide-border">
      {arr.map((t) => (
        <TaskItem key={t.id} task={t} tz={tz} tags={tags} onToggle={(x) => toggle.mutate(x)} overdue={isOverdue} />
      ))}
    </div>
  );

  return (
    <AppShell>
      <div className="mb-8">
        <p className="text-sm text-muted-foreground">{fmt(new Date(), tz, { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight md:text-4xl">
          {greeting(tz)}{first ? `, ${first}` : ""}.
        </h1>
      </div>

      <Card ai className="mb-8 p-6 md:p-8">
        <p className="flex items-center gap-1.5 text-xs font-medium text-ai">
          <AiMark /> Today at a glance
        </p>
        {dLoading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-4/5" />
          </div>
        ) : latest?.summary ? (
          <p className="mt-3 font-serif text-lg leading-relaxed md:text-xl">{latest.summary}</p>
        ) : (
          <p className="mt-3 font-serif text-lg text-muted-foreground">Your first digest arrives tomorrow morning.</p>
        )}
      </Card>

      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-8">
          <section>
            <SectionTitle icon={Sun} action={<Link to="/tasks" className="text-xs text-muted-foreground hover:text-foreground">All tasks</Link>}>
              Today's tasks
            </SectionTitle>
            <Card className="px-2">
              {isLoading ? <div className="p-2"><ListSkeleton /></div> : today.length ? list(today) : (
                <div className="p-2"><EmptyState icon={CheckCircle2}>Nothing due today. Enjoy the calm.</EmptyState></div>
              )}
            </Card>
          </section>
          {overdue.length > 0 && (
            <section>
              <SectionTitle icon={AlertCircle} tone="overdue">Overdue</SectionTitle>
              <Card className="border-overdue/30 bg-overdue-soft px-2">{list(overdue, true)}</Card>
            </section>
          )}
          <section>
            <SectionTitle icon={Cake}>Birthdays in the next 7 days</SectionTitle>
            <Card className="px-2">
              {isLoading ? <div className="p-2"><ListSkeleton rows={1} /></div> : birthdays.length ? list(birthdays) : (
                <div className="p-2"><EmptyState icon={Cake}>No birthdays this week. Tag a task “Birthday” to see it here.</EmptyState></div>
              )}
            </Card>
          </section>
        </div>

        <section>
          <SectionTitle icon={Newspaper} action={<Link to="/news" className="text-xs text-muted-foreground hover:text-foreground">All news</Link>}>
            Top headlines
          </SectionTitle>
          {dLoading || (latest && iLoading) ? (
            <ListSkeleton rows={5} />
          ) : items?.length ? (
            <div className="space-y-3">
              {items.slice(0, 5).map((i) => (
                <NewsCard key={i.id} item={i} compact />
              ))}
            </div>
          ) : (
            <EmptyState icon={Newspaper}>Your first digest arrives tomorrow morning.</EmptyState>
          )}
        </section>
      </div>
    </AppShell>
  );
}
