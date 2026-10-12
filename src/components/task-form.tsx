import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayKey, fromKeys, timeKey } from "@/lib/tz";
import { REMIND_OPTIONS, normalizeInterval, type Task } from "@/lib/task-logic";
import { TAG_COLORS, useDeleteTask, useSaveTask, useTagMutations, useTags } from "@/lib/queries";
import type { TablesInsert } from "@/integrations/supabase/types";
import { ResponsiveModal } from "./responsive-modal";
import { TagChip } from "./common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type TaskDraft = {
  id?: string | undefined;
  title: string;
  notes: string;
  date: string;
  time: string;
  all_day: boolean;
  recurrence: Task["recurrence"];
  priority: Task["priority"];
  tags: string[];
  remind: string;
};

export function emptyDraft(): TaskDraft {
  return {
    title: "",
    notes: "",
    date: "",
    time: "09:00",
    all_day: false,
    recurrence: "none",
    priority: "medium",
    tags: [],
    remind: "",
  };
}

export function taskToDraft(t: Partial<Task>, tz: string): TaskDraft {
  return {
    id: t.id,
    title: t.title ?? "",
    notes: t.notes ?? "",
    date: t.due_at ? dayKey(t.due_at, tz) : "",
    time: t.due_at && !t.all_day ? timeKey(t.due_at, tz) : "09:00",
    all_day: !!t.all_day,
    recurrence: t.recurrence ?? "none",
    priority: t.priority ?? "medium",
    tags: t.tags ?? [],
    remind: normalizeInterval((t.remind_before as string | null) ?? null),
  };
}

export function draftToRow(d: TaskDraft, tz: string): TablesInsert<"tasks"> {
  return {
    title: d.title.trim(),
    notes: d.notes.trim() || null,
    due_at: d.date
      ? fromKeys(d.date, d.all_day ? "00:00" : d.time || "09:00", tz).toISOString()
      : null,
    all_day: d.date ? d.all_day : false,
    recurrence: d.date ? d.recurrence : "none",
    priority: d.priority,
    tags: d.tags,
    remind_before: d.remind || null,
  };
}

export function TaskFields({ draft, set }: { draft: TaskDraft; set: (d: TaskDraft) => void }) {
  const { data: tags = [] } = useTags();
  const { create } = useTagMutations();
  const [newTag, setNewTag] = useState("");
  const [newColor, setNewColor] = useState("blue");
  const [adding, setAdding] = useState(false);
  const up = (p: Partial<TaskDraft>) => set({ ...draft, ...p });

  return (
    <div className="space-y-4">
      <Input
        placeholder="Task title"
        value={draft.title}
        onChange={(e) => up({ title: e.target.value })}
        className="h-11 rounded-xl text-base"
        autoFocus
      />
      <Textarea
        placeholder="Notes"
        rows={2}
        value={draft.notes}
        onChange={(e) => up({ notes: e.target.value })}
        className="rounded-xl"
      />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Due date</Label>
          <Input
            type="date"
            value={draft.date}
            onChange={(e) => up({ date: e.target.value })}
            className="h-11 rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Time</Label>
          <Input
            type="time"
            value={draft.time}
            disabled={draft.all_day || !draft.date}
            onChange={(e) => up({ time: e.target.value })}
            className="h-11 rounded-xl"
          />
        </div>
      </div>
      <label className="flex min-h-11 items-center justify-between rounded-xl border border-border px-3">
        <span className="text-sm">All day</span>
        <Switch checked={draft.all_day} onCheckedChange={(v) => up({ all_day: v })} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Repeat</Label>
          <Select
            value={draft.recurrence}
            onValueChange={(v) => up({ recurrence: v as Task["recurrence"] })}
          >
            <SelectTrigger className="h-11 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["none", "daily", "weekly", "monthly", "yearly"].map((r) => (
                <SelectItem key={r} value={r}>
                  {r === "none" ? "Doesn't repeat" : r.charAt(0).toUpperCase() + r.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Priority</Label>
          <Select
            value={draft.priority}
            onValueChange={(v) => up({ priority: v as Task["priority"] })}
          >
            <SelectTrigger className="h-11 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Remind me</Label>
        <Select
          value={draft.remind || "none"}
          onValueChange={(v) => up({ remind: v === "none" ? "" : v })}
        >
          <SelectTrigger className="h-11 rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REMIND_OPTIONS.map((o) => (
              <SelectItem key={o.label} value={o.value || "none"}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Tags</Label>
        <div className="flex flex-wrap gap-2">
          {tags.map((t: { id: string; name: string; color: string }) => {
            const on = draft.tags.includes(t.name);
            return (
              <button
                type="button"
                key={t.id}
                onClick={() =>
                  up({
                    tags: on ? draft.tags.filter((x) => x !== t.name) : [...draft.tags, t.name],
                  })
                }
                className={cn(
                  "rounded-full ring-offset-2 ring-offset-background transition-calm",
                  on && "ring-2 ring-primary",
                )}
              >
                <TagChip name={t.name} color={t.color} className="px-3 py-1.5" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setAdding(!adding)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <Plus className="size-3" /> New tag
          </button>
        </div>
        {adding && (
          <div className="space-y-2 rounded-xl border border-border p-3">
            <Input
              placeholder="Tag name"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              className="h-10 rounded-lg"
            />
            <ColorPicker value={newColor} onChange={setNewColor} />
            <Button
              type="button"
              size="sm"
              className="rounded-lg"
              disabled={!newTag.trim() || create.isPending}
              onClick={async () => {
                const tag = await create.mutateAsync({ name: newTag.trim(), color: newColor });
                up({ tags: [...draft.tags, tag.name] });
                setNewTag("");
                setAdding(false);
              }}
            >
              Create tag
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn(
            "tag-chip flex size-8 items-center justify-center rounded-full",
            `tag-${c}`,
          )}
        >
          <span className="tag-dot flex size-4 items-center justify-center rounded-full">
            {value === c && <Check className="size-3 text-background" />}
          </span>
        </button>
      ))}
    </div>
  );
}

export function TaskDialog({
  open,
  onOpenChange,
  initial,
  tz,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: TaskDraft;
  tz: string;
}) {
  const [draft, setDraft] = useState(initial);
  const save = useSaveTask();
  const del = useDeleteTask();
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title={draft.id ? "Edit task" : "New task"}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.title.trim()) return;
          await save.mutateAsync(
            draft.id ? { ...draftToRow(draft, tz), id: draft.id } : draftToRow(draft, tz),
          );
          onOpenChange(false);
        }}
      >
        <TaskFields draft={draft} set={setDraft} />
        <div className="mt-6 flex items-center justify-between gap-2">
          {draft.id ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11 rounded-xl text-destructive"
              onClick={async () => {
                await del.mutateAsync(draft.id!);
                onOpenChange(false);
              }}
            >
              <Trash2 /> Delete
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            className="h-11 rounded-xl px-6"
            disabled={!draft.title.trim() || save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />} Save
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}
