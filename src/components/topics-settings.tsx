import { useState } from "react";
import { Loader2, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ListSkeleton } from "@/components/common";
import { useTopicActions, useTopics, type TopicPreview } from "@/lib/queries";

/** The weights worth offering. The column allows anything in (0, 3]. */
const WEIGHTS = [
  { value: 0.8, label: "Less" },
  { value: 1, label: "Normal" },
  { value: 1.5, label: "More" },
  { value: 2, label: "Much more" },
] as const;

const EXAMPLES = [
  "Kubernetes security",
  "semiconductor manufacturing in India",
  "RBI monetary policy",
  "open source developer tooling",
];

/**
 * Topics: the half of "what news do I want" that is not a fixed category.
 *
 * The preview is the important control here, not a nicety. A topic is a guess until you
 * see it hit something — "Kubernetes security" and "k8s CVEs" are one intent to a person
 * and not quite the same point in embedding space — so the honest way to tell someone
 * which phrasing to keep is to show them the articles it would have matched. It also
 * means an interest we have no feeds for says so, instead of silently contributing
 * nothing to every digest from now on.
 */
export function TopicsSettings() {
  const { data: topics, isLoading } = useTopics();
  const { preview, add, setEnabled, setWeight, remove } = useTopicActions();
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState<TopicPreview | null>(null);

  const trimmed = label.trim();
  const canSubmit = trimmed.length >= 2 && !preview.isPending && !add.isPending;

  const runPreview = async () => {
    if (!canSubmit) return;
    const result = await preview.mutateAsync(trimmed).catch(() => null);
    if (result) setShown(result);
  };

  const confirmAdd = async () => {
    if (!canSubmit) return;
    const result = await add.mutateAsync(trimmed).catch(() => null);
    if (result) {
      setLabel("");
      setShown(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="topic">Follow a topic</Label>
        <div className="flex gap-2">
          <Input
            id="topic"
            value={label}
            maxLength={120}
            placeholder="e.g. Kubernetes security"
            onChange={(e) => {
              setLabel(e.target.value);
              setShown(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runPreview();
              }
            }}
          />
          <Button variant="outline" onClick={() => void runPreview()} disabled={!canSubmit}>
            {preview.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            <span className="ml-2 hidden sm:inline">Preview</span>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Matched by meaning against every article we have, so it finds stories no category would
          have surfaced. Write it as a phrase, not keywords.
        </p>
        {!shown && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                type="button"
                className="text-muted-foreground hover:text-foreground border-border rounded-full border px-2.5 py-1 text-xs transition-colors"
                onClick={() => {
                  setLabel(e);
                  setShown(null);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>

      {shown && <PreviewPanel preview={shown} onAdd={confirmAdd} adding={add.isPending} />}

      <div className="space-y-2">
        <Label>Following</Label>
        {isLoading ? (
          <ListSkeleton rows={2} />
        ) : !topics || topics.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No topics yet. Your digest uses your categories alone, exactly as before.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {topics.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <Switch
                  checked={t.enabled}
                  onCheckedChange={(enabled) => setEnabled.mutate({ id: t.id, enabled })}
                  aria-label={`Use ${t.label}`}
                />
                <span
                  className={`flex-1 truncate text-sm ${t.enabled ? "" : "text-muted-foreground line-through"}`}
                >
                  {t.label}
                </span>
                <select
                  className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                  value={String(nearestWeight(t.weight))}
                  onChange={(e) => setWeight.mutate({ id: t.id, weight: Number(e.target.value) })}
                  aria-label={`Weight for ${t.label}`}
                >
                  {WEIGHTS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Stop following ${t.label}`}
                  onClick={() => remove.mutate(t.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The stored weight may be any value; snap it to the nearest offered option. */
function nearestWeight(weight: number): number {
  return WEIGHTS.reduce((best, w) =>
    Math.abs(w.value - weight) < Math.abs(best.value - weight) ? w : best,
  ).value;
}

function PreviewPanel({
  preview,
  onAdd,
  adding,
}: {
  preview: TopicPreview;
  onAdd: () => void;
  adding: boolean;
}) {
  return (
    <div className="border-border bg-muted/30 space-y-3 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm">
          <Sparkles className="text-primary mr-1.5 inline size-3.5" />
          {preview.covered ? (
            <>
              <span className="font-medium">{preview.matches.length}</span> matches in the last{" "}
              {preview.days} days
            </>
          ) : (
            <span className="text-muted-foreground">
              Nothing close enough in the last {preview.days} days — the closest story scored{" "}
              {preview.best_similarity.toFixed(2)}. You can still follow it, but no feed we read
              covers this yet.
            </span>
          )}
        </p>
        <Button size="sm" onClick={onAdd} disabled={adding}>
          {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          <span className="ml-1.5">Follow</span>
        </Button>
      </div>
      {preview.matches.length > 0 && (
        <ul className="space-y-1.5">
          {preview.matches.slice(0, 5).map((m) => (
            <li key={m.title} className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground tabular-nums">{m.similarity.toFixed(2)}</span>
              <span className="flex-1 truncate">{m.title}</span>
              <span className="text-muted-foreground shrink-0">{m.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
