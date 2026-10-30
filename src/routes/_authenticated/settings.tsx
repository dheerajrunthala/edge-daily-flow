import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Loader2, LogOut, Monitor, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell, useSignOut } from "@/components/app-shell";
import { Card, ListSkeleton, PageHeader, TagChip } from "@/components/common";
import { IntegrationsSettings } from "@/components/integrations-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { TopicsSettings } from "@/components/topics-settings";
import { FeaturesSettings } from "@/components/features-settings";
import { CategoryPicker, EmailTimes, Segmented, TimezoneSelect } from "@/components/pref-controls";
import { ColorPicker } from "@/components/task-form";
import {
  TAG_COLORS,
  usePrefs,
  useProfile,
  useTagMutations,
  useTags,
  useUpdatePrefs,
  useUpdateProfile,
  type Tag,
} from "@/lib/queries";
import { useTheme, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Daily Edge" },
      {
        name: "description",
        content: "Manage your profile, news preferences, email times and tags.",
      },
      { property: "og:title", content: "Settings — Daily Edge" },
      {
        property: "og:description",
        content: "Manage your profile, news preferences, email times and tags.",
      },
    ],
  }),
  component: SettingsPage,
});

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="p-5 md:p-6">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </Card>
  );
}

function SettingsPage() {
  const { data: profile } = useProfile();
  const { data: prefs } = usePrefs();
  const upProfile = useUpdateProfile();
  const upPrefs = useUpdatePrefs();
  const { theme, setTheme } = useTheme();
  const signOut = useSignOut();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");

  useEffect(() => {
    if (profile) {
      setName(profile.full_name ?? "");
      setAbout(profile.news_profile ?? "");
    }
  }, [profile]);

  const saved = () => toast.success("Saved");

  return (
    <AppShell>
      <PageHeader title="Settings" />
      {!profile || !prefs ? (
        <ListSkeleton rows={6} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Section title="Profile">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <TimezoneSelect
                  value={profile.timezone}
                  onChange={(tz) => upProfile.mutate({ timezone: tz }, { onSuccess: saved })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="about">About you</Label>
                <Textarea
                  id="about"
                  rows={3}
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  className="rounded-xl"
                />
                <p className="text-xs text-muted-foreground">
                  This personalizes how your news is ranked.
                </p>
              </div>
              <Button
                className="rounded-xl"
                disabled={upProfile.isPending}
                onClick={() =>
                  upProfile.mutate(
                    { full_name: name.trim() || null, news_profile: about.trim() || null },
                    { onSuccess: saved },
                  )
                }
              >
                {upProfile.isPending && <Loader2 className="animate-spin" />} Save profile
              </Button>
            </Section>

            <Section title="Appearance">
              <div className="inline-flex rounded-xl bg-muted p-1">
                {(
                  [
                    ["system", Monitor, "System"],
                    ["light", Sun, "Light"],
                    ["dark", Moon, "Dark"],
                  ] as [ThemePref, typeof Sun, string][]
                ).map(([v, Icon, label]) => (
                  <button
                    key={v}
                    onClick={() => setTheme(v)}
                    className={cn(
                      "flex min-h-10 items-center gap-1.5 rounded-lg px-4 text-sm transition-calm",
                      theme === v ? "bg-card font-medium shadow-soft" : "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" /> {label}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Tags">
              <TagManager />
            </Section>
          </div>

          <div className="space-y-4">
            <Section title="News digest">
              <label className="flex min-h-11 items-center justify-between">
                <span className="text-sm">Daily digest</span>
                <Switch
                  checked={prefs.enabled}
                  onCheckedChange={(v) => upPrefs.mutate({ enabled: v })}
                />
              </label>
              <div className="space-y-2">
                <Label>Categories</Label>
                <p className="text-xs text-muted-foreground">
                  These six are fixed — each one maps to a curated set of feeds, so new categories
                  cannot be typed in here.
                </p>
                <CategoryPicker
                  value={prefs.categories}
                  onChange={(c) =>
                    c.length
                      ? upPrefs.mutate({ categories: c })
                      : toast("Keep at least one category")
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Looking for something more specific, like &ldquo;Kubernetes security&rdquo;?{" "}
                  <a href="#topic" className="font-medium text-foreground underline">
                    Follow it as a topic
                  </a>{" "}
                  below instead.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Headlines per day</Label>
                <div>
                  <Segmented
                    options={[10, 20, 30]}
                    value={prefs.headline_count}
                    onChange={(n) => upPrefs.mutate({ headline_count: n })}
                  />
                </div>
              </div>
            </Section>
            <Section title="Email brief" hint="When your brief lands in your inbox.">
              <EmailTimes
                value={prefs.email_times}
                tz={profile.timezone}
                onChange={(t) => upPrefs.mutate({ email_times: [...t].sort() })}
              />
            </Section>
            <Section
              title="Topics you follow"
              hint="Anything the six categories do not cover. Matched by meaning against every article we have read."
            >
              <TopicsSettings />
            </Section>
            <Section
              title="Reminders"
              hint={`Where task reminders go, and when to stay quiet. Times are in ${profile.timezone.replace(/_/g, " ")}.`}
            >
              <NotificationSettings />
            </Section>
            <Section
              title="Integrations"
              hint="Use Daily Edge from Claude Code or Claude Desktop over MCP."
            >
              <IntegrationsSettings />
            </Section>
            <Section title="Features" hint="Turn parts of Daily Edge off. Enforced server-side.">
              <FeaturesSettings />
            </Section>
            <Button variant="outline" className="h-11 w-full rounded-xl" onClick={signOut}>
              <LogOut /> Sign out
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function TagManager() {
  const { data: tags, isLoading } = useTags();
  if (isLoading) return <ListSkeleton rows={3} />;
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border">
        {tags?.map((t) => (
          <TagRow key={t.id} tag={t} />
        ))}
        {!tags?.length && (
          <p className="text-sm text-muted-foreground">
            No tags yet. Create one below, or while adding a task.
          </p>
        )}
      </div>
      <AddTagRow existing={tags ?? []} />
    </div>
  );
}

/**
 * The "while adding a task" path has always let you type a new tag name; this is the same
 * `create` mutation, just reachable from Settings too. The duplicate-name check here is a
 * client-side guard against the one error worth a dedicated message — `tags_user_id_name_key`
 * — rather than letting the raw constraint violation reach the generic toast.
 */
function AddTagRow({ existing }: { existing: Tag[] }) {
  const { create } = useTagMutations();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TAG_COLORS[0]);

  const submit = () => {
    const n = name.trim();
    if (!n || create.isPending) return;
    if (existing.some((t) => t.name === n)) {
      toast.error(`A tag named "${n}" already exists`);
      return;
    }
    create.mutate({ name: n, color }, { onSuccess: () => setName("") });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Pick a color"
              className="flex size-9 shrink-0 items-center justify-center rounded-full"
            >
              <TagChip name="" color={color} className="size-5 p-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <ColorPicker value={color} onChange={setColor} />
          </PopoverContent>
        </Popover>
        <Input
          value={name}
          placeholder="New tag name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-10 flex-1 rounded-lg"
        />
      </div>
      <Button
        variant="outline"
        size="sm"
        className="rounded-lg sm:shrink-0"
        disabled={!name.trim() || create.isPending}
        onClick={submit}
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add tag
      </Button>
    </div>
  );
}

function TagRow({ tag }: { tag: Tag }) {
  const { update, remove } = useTagMutations();
  const [name, setName] = useState(tag.name);
  const commit = (color = tag.color) => {
    const n = name.trim();
    if (!n) return setName(tag.name);
    if (n !== tag.name || color !== tag.color) update.mutate({ tag, name: n, color });
  };
  return (
    <div className="flex items-center gap-2 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <button aria-label="Change color" className="flex size-10 items-center justify-center">
            <TagChip name="" color={tag.color} className="size-5 p-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <ColorPicker value={tag.color} onChange={(c) => commit(c)} />
        </PopoverContent>
      </Popover>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="h-10 flex-1 rounded-lg border-transparent bg-transparent shadow-none hover:border-border focus-visible:border-border"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-10 rounded-lg text-muted-foreground"
        aria-label="Delete tag"
        onClick={() => remove.mutate(tag)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
