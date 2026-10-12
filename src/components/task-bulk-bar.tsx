import { useState } from "react";
import { CalendarClock, Check, CheckCheck, Tag as TagIcon, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/task-logic";
import type { Tag } from "@/lib/queries";
import { addDaysKey, dayKey, fromKeys } from "@/lib/tz";
import { TagChip } from "./common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The desktop multi-select bar. Deliberately desktop-only: the phone has swipe and the
 * long-press menu, and a selection mode on top of those would fight the gestures for
 * the same taps.
 *
 * Delete asks first *and* still offers Undo afterwards. The confirm is for the twenty
 * rows you are about to lose; the undo is for the moment you realise which twenty.
 */
export function TaskBulkBar({
  selected,
  tags,
  tz,
  onClear,
  onComplete,
  onTag,
  onReschedule,
  onDelete,
}: {
  selected: Task[];
  tags: Tag[];
  tz: string;
  onClear: () => void;
  onComplete: () => void;
  onTag: (name: string, on: boolean) => void;
  onReschedule: (at: Date | null, allDay?: boolean) => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const today = dayKey(new Date(), tz);
  const [day, setDay] = useState(today);
  const [time, setTime] = useState("09:00");
  if (!selected.length) return null;
  const allHave = (name: string) => selected.every((t) => t.tags.includes(name));

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 hidden justify-center px-4 lg:flex">
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-border bg-popover p-2 shadow-lg"
        >
          <span className="px-2 text-sm font-medium tabular-nums">{selected.length} selected</span>
          <span className="mx-1 h-6 w-px bg-border" />
          <Button variant="ghost" className="h-10 rounded-xl" onClick={onComplete}>
            <CheckCheck className="size-4" /> Complete
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="h-10 rounded-xl">
                <TagIcon className="size-4" /> Tag
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-60 p-2">
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                Tap to add to all, tap again to remove.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => {
                  const on = allHave(t.name);
                  return (
                    <button
                      key={t.id}
                      onClick={() => onTag(t.name, !on)}
                      className={cn(
                        "rounded-full ring-offset-2 ring-offset-popover transition-calm",
                        on && "ring-2 ring-primary",
                      )}
                    >
                      <TagChip name={t.name} color={t.color} className="min-h-8 gap-1 px-3">
                        {on && <Check className="size-3" />}
                      </TagChip>
                    </button>
                  );
                })}
                {!tags.length && <p className="text-xs text-muted-foreground">No tags yet.</p>}
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="h-10 rounded-xl">
                <CalendarClock className="size-4" /> Reschedule
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-72 space-y-2 p-3">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onReschedule(fromKeys(today, "09:00", tz))}
                >
                  Today
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onReschedule(fromKeys(addDaysKey(today, 1), "09:00", tz))}
                >
                  Tomorrow
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onReschedule(fromKeys(addDaysKey(today, 7), "09:00", tz))}
                >
                  Next week
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => onReschedule(null)}
                >
                  Someday
                </Button>
              </div>
              <div className="flex gap-2 pt-1">
                <Input
                  type="date"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-lg"
                  aria-label="New date"
                />
                <Input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="h-10 w-24 rounded-lg"
                  aria-label="New time"
                />
                <Button
                  size="sm"
                  className="h-10 rounded-lg"
                  onClick={() => onReschedule(fromKeys(day, time, tz))}
                >
                  Set
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant="ghost"
            className="h-10 rounded-xl text-destructive hover:text-destructive"
            onClick={() => setConfirm(true)}
          >
            <Trash2 className="size-4" /> Delete
          </Button>
          <span className="mx-1 h-6 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon"
            className="size-10 rounded-xl"
            onClick={onClear}
            aria-label="Clear selection"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.length} task{selected.length > 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their completion history goes too. You'll get one chance to undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
