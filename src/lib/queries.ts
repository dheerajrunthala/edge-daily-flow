import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { nextOccurrence, type Task } from "./task-logic";
import { toast } from "sonner";

export type Profile = Tables<"profiles">;
export type Prefs = Tables<"news_prefs">;
export type Tag = Tables<"tags">;
export type Digest = Tables<"digests">;
export type NewsItem = Omit<Tables<"news_items">, "embedding">;

const NEWS_COLS =
  "id,digest_id,user_id,category,headline,summary,why_it_matters,url,source,published_at,importance,rank,related_item_id,is_saved,created_at";

async function uid() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Not signed in");
  return data.user.id;
}

export const qk = {
  profile: ["profile"] as const,
  prefs: ["prefs"] as const,
  tags: ["tags"] as const,
  tasks: ["tasks"] as const,
  digests: ["digests"] as const,
  items: (digestId: string | undefined) => ["news_items", digestId] as const,
  saved: ["news_items", "saved"] as const,
  completions: ["completions"] as const,
};

export const profileQuery = () =>
  queryOptions({
    queryKey: qk.profile,
    queryFn: async () => {
      const id = await uid();
      const { data, error } = await supabase.from("profiles").select("*").eq("id", id).maybeSingle();
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
      const { data, error } = await supabase.from("news_prefs").select("*").eq("user_id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

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
  const { data, error } = await supabase.from("news_items").select(NEWS_COLS).eq("id", id).maybeSingle();
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

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Toggle a task with optimistic update. Recurring tasks log a completion and roll forward. */
export function useToggleTask(tz: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (task: Task) => {
      if (task.status === "done") {
        const { error } = await supabase.from("tasks").update({ status: "todo", completed_at: null }).eq("id", task.id);
        if (error) throw error;
        return;
      }
      if (task.recurrence !== "none" && task.due_at) {
        const { error: e1 } = await supabase
          .from("task_completions")
          .insert({ task_id: task.id, due_at: task.due_at });
        if (e1) throw e1;
        const { error: e2 } = await supabase
          .from("tasks")
          .update({ due_at: nextOccurrence(task.due_at, task.recurrence, tz), last_reminded_at: null })
          .eq("id", task.id);
        if (e2) throw e2;
        return;
      }
      const now = new Date().toISOString();
      const { error } = await supabase.from("tasks").update({ status: "done", completed_at: now }).eq("id", task.id);
      if (error) throw error;
      // Log one-off completions too, so insights reflect them
      await supabase.from("task_completions").insert({ task_id: task.id, due_at: task.due_at, completed_at: now });
    },
    onMutate: async (task) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = qc.getQueryData<Task[]>(qk.tasks);
      qc.setQueryData<Task[]>(qk.tasks, (old) =>
        (old ?? []).map((t) => {
          if (t.id !== task.id) return t;
          if (t.status === "done") return { ...t, status: "todo", completed_at: null };
          if (t.recurrence !== "none" && t.due_at)
            return { ...t, due_at: nextOccurrence(t.due_at, t.recurrence, tz) };
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
      if (task.recurrence !== "none" && task.status !== "done") toast.success("Done — next one scheduled");
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
        const { data: rows } = await supabase.from("tasks").select("id,tags").contains("tags", [tag.name]);
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
      const { data: rows } = await supabase.from("tasks").select("id,tags").contains("tags", [tag.name]);
      for (const r of rows ?? []) {
        await supabase.from("tasks").update({ tags: r.tags.filter((x: string) => x !== tag.name) }).eq("id", r.id);
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
      const { error } = await supabase.from("news_items").update({ is_saved: !item.is_saved }).eq("id", item.id);
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

export const CATEGORIES = [
  "AI",
  "Software Development",
  "Indian Stock Market",
  "Indian Startups & Tech",
  "Global Tech",
  "Policy & Regulation",
];

export const TAG_COLORS = ["slate", "blue", "green", "amber", "rose", "violet", "cyan", "orange"];
