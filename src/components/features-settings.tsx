import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ListSkeleton } from "@/components/common";
import { FEATURES, useFeatures, useSetFeature, type FeatureName } from "@/lib/queries";

/**
 * What each switch actually turns off.
 *
 * Written as consequences rather than feature names, because the only reason to read this
 * list is to decide whether turning something off will cost you something you wanted. The
 * copy says what stops happening, not what the feature is called.
 */
const COPY: Record<FeatureName, { title: string; detail: string }> = {
  digest: {
    title: "Daily news digest",
    detail: "Build a curated brief each morning. Off means no new digests and no brief email.",
  },
  topics: {
    title: "Topic matching",
    detail:
      "Include topics you follow when picking stories. Off falls back to your categories alone.",
  },
  followups: {
    title: "Follow-up linking",
    detail: 'Point a story at the earlier one it continues, shown as a "Follow-up" badge.',
  },
  reminders: {
    title: "Task reminders",
    detail: "The escalation ladder: lead, due and nagging. Off silences every task reminder.",
  },
  planner: {
    title: "Morning plan",
    detail:
      "An assistant reads your tasks and brief each morning and suggests an order for the day. Off by default — nothing should message you unasked.",
  },
  chat: {
    title: "Assistant",
    detail: "Ask about your news and tasks in your own words, and create tasks from the answer.",
  },
  voice: {
    title: "Voice input",
    detail: "Dictate to the assistant instead of typing. Uses your browser's speech recognition.",
  },
  telegram: {
    title: "Telegram",
    detail: "Deliver notifications to the bot. Linking and unlinking live under Reminders.",
  },
  push: {
    title: "Desktop notifications",
    detail: "Deliver notifications to this browser, even with the tab closed.",
  },
};

/**
 * Feature switches.
 *
 * Worth saying plainly in the UI: these are enforced on the server, at the entry point of
 * every function that would act. Turning the morning plan off does not hide a card, it
 * stops the cron job from spending anything on you — which is the only version of a
 * switch that is worth having.
 */
export function FeaturesSettings() {
  const { data: features, isLoading } = useFeatures();
  const setFeature = useSetFeature();

  if (isLoading || !features) return <ListSkeleton rows={4} />;

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground mb-3 text-xs">
        Enforced on the server, not just hidden here — turning one off stops the work from running
        at all.
      </p>
      <ul className="divide-border divide-y">
        {FEATURES.map((feature) => {
          const copy = COPY[feature];
          const pending = setFeature.isPending && setFeature.variables?.feature === feature;
          return (
            <li key={feature} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{copy.title}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{copy.detail}</p>
              </div>
              {pending ? (
                <Loader2 className="text-muted-foreground mt-1 size-4 shrink-0 animate-spin" />
              ) : (
                <Switch
                  className="mt-1 shrink-0"
                  checked={features[feature]}
                  onCheckedChange={(enabled) => setFeature.mutate({ feature, enabled })}
                  aria-label={copy.title}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
