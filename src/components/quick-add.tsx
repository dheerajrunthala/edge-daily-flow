import { forwardRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useInsertTasks } from "@/lib/queries";
import type { Task } from "@/lib/task-logic";
import { ResponsiveModal } from "./responsive-modal";
import { TaskFields, draftToRow, taskToDraft, type TaskDraft } from "./task-form";
import { Button } from "@/components/ui/button";

/** What parse-task returns. It only previews — nothing is written until the user saves. */
type ParseTaskResponse = { tasks: Partial<Task>[]; remaining?: number };

/**
 * invoke() reports an HTTP error without reading the body, so the function's own message
 * (rate limit, validation, upstream failure) is in error.context and has to be unwrapped.
 */
async function parseTaskErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null);
    if (body && typeof body.error === "string") return body.error;
  }
  return "Couldn't reach the AI parser. Please try again.";
}

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
      const { data, error } = await supabase.functions.invoke<ParseTaskResponse>("parse-task", {
        body: { text },
      });
      if (error) throw new Error(await parseTaskErrorMessage(error));

      const tasks = data?.tasks ?? [];
      if (!tasks.length) {
        toast("Couldn't find a task in that", {
          description: "Try naming what to do and when, e.g. “pay rent on the 5th”.",
        });
        return;
      }
      setPreview(tasks.map((t) => taskToDraft(t, tz)));
      setEditing(0);
      // Only worth mentioning once the daily allowance is close to running out.
      if (typeof data?.remaining === "number" && data.remaining <= 5) {
        toast(`${data.remaining} AI parses left today`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function saveAll() {
    if (!preview) return;
    const rows = preview
      .filter((d) => d.title.trim())
      .map((d) => ({ ...draftToRow(d, tz), source: "ai" }));
    if (!rows.length) return;
    await insert.mutateAsync(rows);
    toast.success(`Added ${rows.length} task${rows.length > 1 ? "s" : ""}`);
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
