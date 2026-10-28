import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums, Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { qk } from "./query-keys";
import { completeOne, reopenOne, restoreTasks, uncompleteOne } from "./task-actions";
import { nextOccurrenceAhead, type Task } from "./task-logic";
import { toast } from "sonner";

export type Profile = Tables<"profiles">;
export type Prefs = Tables<"news_prefs">;
export type NotifyPrefs = Tables<"notification_prefs">;
export type NotifyChannel = Enums<"notification_channel">;
export type Tag = Tables<"tags">;
export type Digest = Tables<"digests">;
export type NewsItem = Omit<Tables<"news_items">, "embedding">;

// One literal, not a concatenation: supabase-js infers the row type from the select
// string, and a `+` turns it back into a plain string and the result into GenericStringError.
const NEWS_COLS =
  "id,digest_id,user_id,category,headline,summary,why_it_matters,url,source,published_at,importance,rank,related_item_id,is_saved,read_at,url_resolved,created_at";

async function uid() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Not signed in");
  return data.user.id;
}

export { qk } from "./query-keys";

export const profileQuery = () =>
  queryOptions({
    queryKey: qk.profile,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

export const useProfile = () => useQuery(profileQuery());
export const useTz = () => useProfile().data?.timezone ?? "Asia/Kolkata";

export const usePrefs = () =>
  useQuery({
    queryKey: qk.prefs,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("news_prefs")
        .select("*")
        .eq("user_id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

export const useNotifyPrefs = () =>
  useQuery({
    queryKey: qk.notifyPrefs,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("*")
        .eq("user_id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

/**
 * chat_id and linked_at only — the link code is never needed after it is handed over.
 * `poll` is for the few seconds after Connect is tapped: the link is completed by
 * Telegram calling the webhook, so the browser has nothing to await and must look.
 */
export const useTelegramLink = (poll = false) =>
  useQuery({
    queryKey: qk.telegram,
    refetchInterval: poll ? 3000 : false,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("telegram_links")
        .select("chat_id, linked_at")
        .eq("user_id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

/**
 * The browsers this account has subscribed. Readable by the owner so Settings can say
 * "on in 2 browsers"; the rows themselves are only ever written by push-subscribe.
 */
export const usePushSubscriptions = () =>
  useQuery({
    queryKey: qk.pushSubs,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, user_agent, created_at, last_used_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

/**
 * The account's MCP API tokens.
 *
 * Columns are named explicitly and `token_hash` is deliberately absent — the migration
 * grants `authenticated` SELECT on these columns only, so `select("*")` would fail. The
 * hash is of no use to the owner and there is no reason for it to travel to a browser.
 */
export const useApiTokens = () =>
  useQuery({
    queryKey: qk.apiTokens,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("api_tokens")
        .select("id, name, prefix, last_used_at, revoked_at, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export type ApiTokenRow = NonNullable<ReturnType<typeof useApiTokens>["data"]>[number];

/**
 * Create, revoke and delete tokens.
 *
 * `create` returns the plaintext token, which exists in this one response and nowhere
 * else, ever — it is minted and hashed inside `create_api_token()` and the browser only
 * ever sees the result. The caller must show it to the user immediately; there is no
 * second chance and no "reveal" later.
 *
 * Revoke and delete are separate on purpose. Revoking stops the token working while
 * leaving the row (and so the record of what it did) in place; deleting removes it from
 * the list. Revoking first is the safe order when a token may be in a config file
 * somewhere you cannot remember.
 */
export function useApiTokenActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.apiTokens });
  const onError = (e: Error) => toast.error(e.message);

  const create = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase.rpc("create_api_token", { p_name: name });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.token) throw new Error("Could not create a token");
      return row as { id: string; token: string; prefix: string; name: string };
    },
    onSuccess: done,
    onError,
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("api_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      done();
      toast.success("Token revoked");
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("api_tokens").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      done();
      toast.success("Token deleted");
    },
    onError,
  });

  return { create, revoke, remove };
}

export const useTags = () =>
  useQuery({
    queryKey: qk.tags,
    queryFn: async () => {
      const { data, error } = await supabase.from("tags").select("*").order("created_at");
      if (error) throw error;
      return data;
    },
  });

export const useTasks = () =>
  useQuery({
    queryKey: qk.tasks,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

export const useDigests = () =>
  useQuery({
    queryKey: qk.digests,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("digests")
        .select("*")
        .order("digest_date", { ascending: false })
        .limit(120);
      if (error) throw error;
      return data;
    },
  });

export const useNewsItems = (digestId: string | undefined) =>
  useQuery({
    queryKey: qk.items(digestId),
    enabled: !!digestId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("news_items")
        .select(NEWS_COLS)
        .eq("digest_id", digestId!)
        .order("rank", { ascending: true, nullsFirst: false })
        .order("importance", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as NewsItem[];
    },
  });

export const useSavedItems = () =>
  useQuery({
    queryKey: qk.saved,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("news_items")
        .select(NEWS_COLS)
        .eq("is_saved", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as NewsItem[];
    },
  });

export async function fetchNewsItem(id: string) {
  const { data, error } = await supabase
    .from("news_items")
    .select(NEWS_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as NewsItem | null;
}

export const useCompletions = () =>
  useQuery({
    queryKey: qk.completions,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("task_completions")
        .select("*")
        .order("completed_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return data;
    },
  });

// ---------- Mutations ----------

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: TablesUpdate<"profiles">) => {
      const id = await uid();
      const { error } = await supabase.from("profiles").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.profile }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdatePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: TablesUpdate<"news_prefs">) => {
      const id = await uid();
      const { error } = await supabase.from("news_prefs").update(patch).eq("user_id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.prefs }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateNotifyPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Omit<TablesUpdate<"notification_prefs">, "user_id">) => {
      const id = await uid();
      // Upsert, not update: a user who signed up before notification_prefs existed and
      // somehow missed the backfill would otherwise silently fail to save anything.
      const { error } = await supabase
        .from("notification_prefs")
        .upsert({ ...patch, user_id: id }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notifyPrefs }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Connect and disconnect Telegram. The code is minted by the database
 * (request_telegram_link), never by the browser, and is good for one /start within
 * 15 minutes.
 */
export function useTelegramActions() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: qk.telegram });
    qc.invalidateQueries({ queryKey: qk.notifyPrefs });
  };
  const onError = (e: Error) => toast.error(e.message);

  const connect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("request_telegram_link");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.code) throw new Error("Could not create a link code");
      return row;
    },
    onSuccess: done,
    onError,
  });

  const unlink = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("unlink_telegram");
      if (error) throw error;
    },
    onSuccess: () => {
      done();
      toast.success("Telegram disconnected");
    },
    onError,
  });

  return { connect, unlink };
}

export function useSaveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (t: TablesInsert<"tasks"> & { id?: string }) => {
      if (t.id) {
        const { id, ...rest } = t;
        const { error } = await supabase.from("tasks").update(rest).eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("tasks").insert(t);
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useInsertTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: TablesInsert<"tasks">[]) => {
      const { error } = await supabase.from("tasks").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Delete a task, keeping a copy so the toast can offer Undo. The row is read back from
 * the database rather than taken from the cache, so a restore puts back what was really
 * there; it is re-inserted with its original id.
 */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: before } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
      return before;
    },
    onSuccess: (before) => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      if (!before) return;
      toast.success("Task deleted", {
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await restoreTasks([before]);
            } catch (e) {
              toast.error((e as Error).message);
            }
            qc.invalidateQueries({ queryKey: qk.tasks });
          },
        },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Toggle a task from a checkbox, optimistically, with an undo.
 *
 * The write itself lives in `task-actions.ts` so the swipe, the long-press menu, the
 * bulk bar and this checkbox all complete a task the same way — including the
 * roll-forward of a recurring one. What this adds is the optimistic repaint (the tick
 * has to land under the finger, not after a round trip) and the undo toast, because a
 * mis-tap on a recurring task has already moved its due date.
 */
export function useToggleTask(tz: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (task: Task) =>
      task.status === "done" ? reopenOne(task) : completeOne(task, tz),
    onMutate: async (task) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = qc.getQueryData<Task[]>(qk.tasks);
      qc.setQueryData<Task[]>(qk.tasks, (old) =>
        (old ?? []).map((t) => {
          if (t.id !== task.id) return t;
          if (t.status === "done") return { ...t, status: "todo", completed_at: null };
          if (t.recurrence !== "none" && t.due_at)
            return { ...t, due_at: nextOccurrenceAhead(t.due_at, t.recurrence, tz, t.all_day) };
          return { ...t, status: "done", completed_at: new Date().toISOString() };
        }),
      );
      return { prev };
    },
    onError: (e: Error, _t, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks, ctx.prev);
      toast.error(e.message);
    },
    onSuccess: (_d, task) => {
      if (task.status === "done") return; // reopening is its own undo
      toast.success(task.recurrence !== "none" ? "Done — next one scheduled" : "Task completed", {
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await uncompleteOne(task);
            } catch (e) {
              toast.error((e as Error).message);
            }
            qc.invalidateQueries({ queryKey: qk.tasks });
            qc.invalidateQueries({ queryKey: qk.completions });
          },
        },
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.tasks });
      qc.invalidateQueries({ queryKey: qk.completions });
    },
  });
}

export function useTagMutations() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: qk.tags });
    qc.invalidateQueries({ queryKey: qk.tasks });
  };
  const onError = (e: Error) => toast.error(e.message);
  const create = useMutation({
    mutationFn: async (t: { name: string; color: string }) => {
      const { data, error } = await supabase.from("tags").insert(t).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: done,
    onError,
  });
  const update = useMutation({
    mutationFn: async ({ tag, name, color }: { tag: Tag; name: string; color: string }) => {
      const { error } = await supabase.from("tags").update({ name, color }).eq("id", tag.id);
      if (error) throw error;
      if (name !== tag.name) {
        // Keep task tag arrays in sync with the rename
        const { data: rows } = await supabase
          .from("tasks")
          .select("id,tags")
          .contains("tags", [tag.name]);
        for (const r of rows ?? []) {
          await supabase
            .from("tasks")
            .update({ tags: r.tags.map((x: string) => (x === tag.name ? name : x)) })
            .eq("id", r.id);
        }
      }
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({
    mutationFn: async (tag: Tag) => {
      const { error } = await supabase.from("tags").delete().eq("id", tag.id);
      if (error) throw error;
      const { data: rows } = await supabase
        .from("tasks")
        .select("id,tags")
        .contains("tags", [tag.name]);
      for (const r of rows ?? []) {
        await supabase
          .from("tasks")
          .update({ tags: r.tags.filter((x: string) => x !== tag.name) })
          .eq("id", r.id);
      }
    },
    onSuccess: done,
    onError,
  });
  return { create, update, remove };
}

export function useToggleSaved() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (item: NewsItem) => {
      const { error } = await supabase
        .from("news_items")
        .update({ is_saved: !item.is_saved })
        .eq("id", item.id);
      if (error) throw error;
    },
    onMutate: async (item) => {
      const key = qk.items(item.digest_id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<NewsItem[]>(key);
      qc.setQueryData<NewsItem[]>(key, (old) =>
        old?.map((i) => (i.id === item.id ? { ...i, is_saved: !i.is_saved } : i)),
      );
      return { prev, key };
    },
    onError: (e: Error, _i, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["news_items"] }),
  });
}

/**
 * Mark stories read — one when its link is opened, a whole section from its header.
 *
 * Opening the link is the only honest signal the browser has: a card that scrolled past
 * was not necessarily read. The write is optimistic and deliberately unguarded by a
 * toast; this is bookkeeping, not an action the user asked for, and it must not steal
 * attention from the tab they just opened.
 */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ items, read }: { items: NewsItem[]; read: boolean }) => {
      const ids = items.filter((i) => !!i.read_at !== read).map((i) => i.id);
      if (!ids.length) return;
      const { error } = await supabase
        .from("news_items")
        .update({ read_at: read ? new Date().toISOString() : null })
        .in("id", ids);
      if (error) throw error;
    },
    onMutate: async ({ items, read }) => {
      const key = qk.items(items[0]?.digest_id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<NewsItem[]>(key);
      const ids = new Set(items.map((i) => i.id));
      qc.setQueryData<NewsItem[]>(key, (old) =>
        old?.map((i) =>
          ids.has(i.id) ? { ...i, read_at: read ? new Date().toISOString() : null } : i,
        ),
      );
      return { prev, key };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["news_items"] }),
  });
}

export const CATEGORIES = [
  "AI",
  "Software Development",
  "Indian Stock Market",
  "Indian Startups & Tech",
  "Global Tech",
  "Policy & Regulation",
];

export const TAG_COLORS = ["slate", "blue", "green", "amber", "rose", "violet", "cyan", "orange"];

// ----------------------------------------------------------------- topics

export type Topic = Omit<Tables<"topics">, "embedding">;

/**
 * A topic the user follows, without its vector.
 *
 * The embedding is excluded by naming columns rather than selecting `*`, the same
 * discipline api_tokens needs for token_hash: a 768-float array is a few KB per row that
 * the browser has no use for, and it would be in every topics response forever.
 */
const TOPIC_COLS = "id,user_id,label,enabled,weight,created_at";

export function useTopics() {
  return useQuery({
    queryKey: qk.topics,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("topics")
        .select(TOPIC_COLS)
        .eq("user_id", id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Topic[];
    },
  });
}

export type TopicPreview = {
  label: string;
  days: number;
  covered: boolean;
  best_similarity: number;
  matches: { title: string; source: string; category: string; similarity: number }[];
};

/**
 * Add, preview and remove topics.
 *
 * Adding goes through the Edge Function because creating a topic means embedding its
 * label and the browser never holds the Gemini key — which is also why `topics` has no
 * insert policy. Toggling and deleting are plain RLS writes, so they stay here.
 */
export function useTopicActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.topics });

  const preview = useMutation({
    mutationFn: async (label: string) => {
      const { data, error } = await supabase.functions.invoke("topics", {
        body: { action: "preview", label },
      });
      if (error) throw new Error(readFnError(error, "Could not preview that topic"));
      return data as TopicPreview;
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const add = useMutation({
    mutationFn: async (label: string) => {
      const { data, error } = await supabase.functions.invoke("topics", {
        body: { action: "add", label },
      });
      if (error) throw new Error(readFnError(error, "Could not add that topic"));
      return data as TopicPreview & { topic: Topic };
    },
    onSuccess: (res) => {
      invalidate();
      toast.success(
        res.covered
          ? `Following "${res.topic.label}"`
          : `Following "${res.topic.label}" — nothing in the archive matches it yet`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("topics").update({ enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const setWeight = useMutation({
    mutationFn: async ({ id, weight }: { id: string; weight: number }) => {
      const { error } = await supabase.from("topics").update({ weight }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("topics").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  return { preview, add, setEnabled, setWeight, remove };
}

// ----------------------------------------------------------------- features

export const FEATURES = [
  "digest",
  "topics",
  "reminders",
  "planner",
  "chat",
  "voice",
  "followups",
  "telegram",
  "push",
] as const;
export type FeatureName = (typeof FEATURES)[number];

/**
 * Features default ON, except the planner.
 *
 * Mirrors DEFAULT_OFF in supabase/functions/_shared/features.ts, and the two must agree:
 * the switch the user sees here and the gate the cron reads there are the same promise. If
 * you change one, change the other — there is a test pinning the list.
 */
const DEFAULT_OFF: ReadonlySet<FeatureName> = new Set<FeatureName>(["planner"]);

export function featureDefault(feature: FeatureName): boolean {
  return !DEFAULT_OFF.has(feature);
}

/** Every switch, with absent rows resolved to their default. */
export function useFeatures() {
  return useQuery({
    queryKey: qk.features,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase
        .from("user_features")
        .select("feature,enabled")
        .eq("user_id", id);
      if (error) throw error;
      const rows = new Map((data ?? []).map((r) => [r.feature, r.enabled]));
      return Object.fromEntries(
        FEATURES.map((f) => [f, rows.has(f) ? !!rows.get(f) : featureDefault(f)]),
      ) as Record<FeatureName, boolean>;
    },
  });
}

export function useSetFeature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ feature, enabled }: { feature: FeatureName; enabled: boolean }) => {
      const id = await uid();
      // Upsert rather than update: the row only exists once the user has touched the
      // switch, because an absent row is what "default" means.
      const { error } = await supabase
        .from("user_features")
        .upsert(
          { user_id: id, feature, enabled, updated_at: new Date().toISOString() },
          { onConflict: "user_id,feature" },
        );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.features }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * The message inside a FunctionsHttpError, which supabase-js does not unwrap.
 *
 * Without this every failure from an Edge Function reads "Edge Function returned a
 * non-2xx status code", which hides the one useful sentence the handler wrote — the daily
 * limit, the duplicate topic, the 120-char cap.
 */
function readFnError(error: unknown, fallback: string): string {
  const ctx = (error as { context?: unknown })?.context;
  const body = (ctx as { body?: unknown })?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* not JSON; fall through */
    }
  }
  const msg = (error as { message?: string })?.message;
  return msg && !msg.includes("non-2xx") ? msg : fallback;
}
