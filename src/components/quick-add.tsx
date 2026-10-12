import { forwardRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useInsertTasks } from "@/lib/queries";
import type { Task } from "@/lib/task-logic";
import { ResponsiveModal } from "./responsive-modal";
import { TaskFields, draftToRow, taskToDraft, type TaskDraft } from "./task-form";
import { Button } from "@/components/ui/button";

export const QuickAdd = forwardRef<HTMLInputElement, { tz: string }>(function QuickAdd(
  { tz },
  ref,
) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<TaskDraft[] | null>(null);
  const [editing, setEditing] = useState(0);
  const insert = useInsertTasks();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setLoading(true);
    try {
      // TODO: 'parse-task' edge function is built later. Expected response: { tasks: Partial<Task>[] }
      const { data, error } = await supabase.functions.invoke("parse-task", { body: { text } });
      if (error) throw error;
      const tasks = (data?.tasks ?? []) as Partial<Task>[];
      if (!tasks.length) throw new Error("empty");
      setPreview(tasks.map((t) => taskToDraft(t, tz)));
      setEditing(0);
    } catch {
      toast("AI quick-add is coming soon", {
        description: "For now, use the + button to add tasks.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function saveAll() {
    if (!preview) return;
    await insert.mutateAsync(
      preview.filter((d) => d.title.trim()).map((d) => ({ ...draftToRow(d, tz), source: "ai" })),
    );
    toast.success(`Added ${preview.length} task${preview.length > 1 ? "s" : ""}`);
    setPreview(null);
    setText("");
  }

  return (
    <>
      <form
        onSubmit={submit}
        className="ai-border flex items-center gap-2 rounded-2xl px-3 shadow-soft"
      >
        <Sparkles className="size-4 shrink-0 text-ai" />
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Try: call Rahul next Tue 3pm #office, mom's birthday 14 Nov every year"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground md:inline">
          ⌘K
        </kbd>
        <Button type="submit" size="sm" className="rounded-lg" disabled={loading || !text.trim()}>
          {loading ? <Loader2 className="animate-spin" /> : "Add"}
        </Button>
      </form>

      <ResponsiveModal
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Review AI tasks"
      >
        {preview && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {preview.map((d, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${i === editing ? "border-primary bg-ai-soft" : "border-border"}`}
                >
                  <button type="button" onClick={() => setEditing(i)}>
                    {d.title || "Untitled"}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => {
                      const next = preview.filter((_, j) => j !== i);
                      setPreview(next.length ? next : null);
                      setEditing(0);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            {preview[editing] && (
              <TaskFields
                key={editing}
                draft={preview[editing]}
                set={(d) => setPreview(preview.map((x, j) => (j === editing ? d : x)))}
              />
            )}
            <Button
              className="h-11 w-full rounded-xl"
              onClick={saveAll}
              disabled={insert.isPending}
            >
              {insert.isPending && <Loader2 className="animate-spin" />} Save {preview.length} task
              {preview.length > 1 ? "s" : ""}
            </Button>
          </div>
        )}
      </ResponsiveModal>
    </>
  );
});
