import { Bookmark, ExternalLink, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/tz";
import { useToggleSaved, type NewsItem } from "@/lib/queries";

export function NewsCard({
  item,
  onFollowUp,
  compact,
  onOpen,
}: {
  item: NewsItem;
  onFollowUp?: (id: string) => void;
  compact?: boolean;
  /** Called when the story's link is opened — the only honest "read" signal. */
  onOpen?: ((item: NewsItem) => void) | undefined;
}) {
  const toggle = useToggleSaved();
  const read = !!item.read_at;
  return (
    <article
      className={cn(
        "rounded-2xl border border-border bg-card p-5 transition-calm hover:shadow-soft",
        // Read stories recede rather than disappear: you still want to find the one you
        // opened this morning, you just don't want it competing with what is new.
        read && "opacity-55 hover:opacity-100",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">{item.category}</span>
        {item.related_item_id && (
          <button
            onClick={() => onFollowUp?.(item.related_item_id!)}
            className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 font-medium text-ai"
          >
            <Link2 className="size-3" /> Follow-up
          </button>
        )}
      </div>
      <h3 className={cn("font-serif leading-snug", compact ? "text-lg" : "text-xl")}>
        {/* The headline is the link people actually click, so it has to count as a read
            too — not just the icon in the corner. */}
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onOpen?.(item)}
          onAuxClick={() => onOpen?.(item)}
          className="rounded transition-calm hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.headline}
        </a>
      </h3>
      {!compact && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
      )}
      {!compact && item.why_it_matters && (
        <p className="mt-3 text-sm text-ai-muted">
          <span className="font-medium">Why it matters: </span>
          {item.why_it_matters}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {item.source}
            {item.published_at && ` · ${relativeTime(item.published_at)}`}
          </p>
          {/* The link is still a Google News redirect, so say so rather than implying
              it goes straight to the publisher. */}
          {!item.url_resolved && (
            <span
              title="Opens via Google News, which redirects to the publisher"
              className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              via Google News
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => toggle.mutate(item)}
            aria-label={item.is_saved ? "Remove bookmark" : "Bookmark"}
            className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-calm hover:bg-accent hover:text-foreground"
          >
            <Bookmark className={cn("size-4", item.is_saved && "fill-primary text-primary")} />
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onOpen?.(item)}
            onAuxClick={() => onOpen?.(item)}
            aria-label="Open article"
            className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-calm hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>
    </article>
  );
}
