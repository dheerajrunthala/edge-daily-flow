import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bookmark, Check, ChevronDown, Newspaper } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { AiMark, Card, EmptyState, ListSkeleton, PageHeader } from "@/components/common";
import { NewsCard } from "@/components/news-card";
import { ResponsiveModal } from "@/components/responsive-modal";
import {
  fetchNewsItem,
  useDigests,
  useMarkRead,
  useNewsItems,
  useSavedItems,
  useTz,
  type NewsItem,
} from "@/lib/queries";
import { loadPref, savePref } from "@/lib/view-prefs";
import { fmt, fromKeys } from "@/lib/tz";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/news")({
  head: () => ({
    meta: [
      { title: "News — Daily Edge" },
      { name: "description", content: "Your daily AI-curated news digest, grouped by topic." },
      { property: "og:title", content: "News — Daily Edge" },
      {
        property: "og:description",
        content: "Your daily AI-curated news digest, grouped by topic.",
      },
    ],
  }),
  component: NewsPage,
});

/** Collapse state is per category name, so it survives a new digest each morning. */
const COLLAPSE_KEY = "news.collapsed";

function NewsPage() {
  const tz = useTz();
  const [tab, setTab] = useState<"digest" | "saved">("digest");
  const { data: digests, isLoading } = useDigests();
  const [digestId, setDigestId] = useState<string>();
  useEffect(() => {
    if (!digestId && digests?.length) setDigestId(digests[0]!.id);
  }, [digests, digestId]);
  const digest = digests?.find((d) => d.id === digestId);
  const { data: items, isLoading: iLoading } = useNewsItems(digestId);
  const saved = useSavedItems();
  const [followId, setFollowId] = useState<string | null>(null);
  const markRead = useMarkRead();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => setCollapsed(loadPref<string[]>(COLLAPSE_KEY, [])), []);
  const toggleSection = (cat: string) => {
    const next = collapsed.includes(cat) ? collapsed.filter((c) => c !== cat) : [...collapsed, cat];
    setCollapsed(next);
    savePref(COLLAPSE_KEY, next);
  };
  const open = (i: NewsItem) => markRead.mutate({ items: [i], read: true });

  const grouped = useMemo(() => {
    const map = new Map<string, NonNullable<typeof items>>();
    for (const i of items ?? []) map.set(i.category, [...(map.get(i.category) ?? []), i]);
    return [...map.entries()];
  }, [items]);

  const dateLabel = (d: string) =>
    fmt(fromKeys(d, "12:00", tz), tz, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  return (
    <AppShell>
      <PageHeader
        title="News"
        action={
          tab === "digest" && digests && digests.length > 0 ? (
            <Select value={digestId ?? ""} onValueChange={setDigestId}>
              <SelectTrigger className="h-10 w-56 rounded-xl">
                <SelectValue placeholder="Pick a date" />
              </SelectTrigger>
              <SelectContent>
                {digests.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {dateLabel(d.digest_date)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />
      <div className="mb-6 inline-flex rounded-xl bg-muted p-1">
        {(["digest", "saved"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-lg px-4 text-sm transition-calm",
              tab === t ? "bg-card font-medium shadow-soft" : "text-muted-foreground",
            )}
          >
            {t === "digest" ? <Newspaper className="size-4" /> : <Bookmark className="size-4" />}
            {t === "digest" ? "Digest" : "Saved"}
          </button>
        ))}
      </div>

      {tab === "digest" ? (
        isLoading || (digestId && iLoading) ? (
          <ListSkeleton rows={5} />
        ) : !digests?.length ? (
          <EmptyState icon={Newspaper}>Your first digest arrives tomorrow morning.</EmptyState>
        ) : (
          <div className="space-y-10">
            {digest?.summary && (
              <Card ai className="p-6">
                <p className="flex items-center gap-1.5 text-xs font-medium text-ai">
                  <AiMark /> Summary
                </p>
                <p className="mt-2 font-serif text-lg leading-relaxed">{digest.summary}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {digest.items_count} stories from {digest.sources_scanned} articles scanned
                </p>
              </Card>
            )}
            {digest?.status === "pending" && (
              <EmptyState icon={Newspaper}>This digest is still being prepared.</EmptyState>
            )}
            {digest?.status === "failed" && (
              <EmptyState icon={Newspaper}>This digest couldn't be generated.</EmptyState>
            )}
            {grouped.map(([cat, list]) => {
              const shut = collapsed.includes(cat);
              const unread = list.filter((i) => !i.read_at).length;
              return (
                <section key={cat}>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <button
                      onClick={() => toggleSection(cat)}
                      aria-expanded={!shut}
                      className="flex min-h-11 items-center gap-2 rounded-lg text-left"
                    >
                      <ChevronDown
                        className={cn(
                          "size-5 shrink-0 text-muted-foreground transition-transform",
                          shut && "-rotate-90",
                        )}
                      />
                      <h2 className="font-serif text-2xl">{cat}</h2>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {unread ? `${unread}/${list.length}` : list.length}
                      </span>
                    </button>
                    {unread > 0 && (
                      <button
                        onClick={() => markRead.mutate({ items: list, read: true })}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-calm hover:text-foreground"
                      >
                        <Check className="size-3.5" /> Mark read
                      </button>
                    )}
                  </div>
                  {!shut && (
                    <div className="grid gap-3 md:grid-cols-2">
                      {list.map((i) => (
                        <NewsCard key={i.id} item={i} onFollowUp={setFollowId} onOpen={open} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )
      ) : saved.isLoading ? (
        <ListSkeleton rows={4} />
      ) : saved.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {saved.data.map((i) => (
            <NewsCard key={i.id} item={i} onFollowUp={setFollowId} onOpen={open} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Bookmark}>Bookmark stories to read them later.</EmptyState>
      )}

      <FollowUp id={followId} onClose={() => setFollowId(null)} onFollowUp={setFollowId} />
    </AppShell>
  );
}

function FollowUp({
  id,
  onClose,
  onFollowUp,
}: {
  id: string | null;
  onClose: () => void;
  onFollowUp: (id: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["news_item", id],
    enabled: !!id,
    queryFn: () => fetchNewsItem(id!),
  });
  return (
    <ResponsiveModal open={!!id} onOpenChange={(o) => !o && onClose()} title="Earlier story">
      {isLoading ? (
        <ListSkeleton rows={2} />
      ) : data ? (
        <NewsCard item={data} onFollowUp={onFollowUp} />
      ) : (
        <p className="text-sm text-muted-foreground">Story not found.</p>
      )}
    </ResponsiveModal>
  );
}
