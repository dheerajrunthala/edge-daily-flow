import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { allTimezones, fmt, fromKeys, dayKey } from "@/lib/tz";
import { CATEGORIES } from "@/lib/queries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => allTimezones(), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 w-full justify-between rounded-xl font-normal">
          {value || "Select timezone"}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            {zones.map((z) => (
              <CommandItem
                key={z}
                value={z}
                onSelect={() => {
                  onChange(z);
                  setOpen(false);
                }}
              >
                <Check className={cn("size-4", z === value ? "opacity-100" : "opacity-0")} />
                {z.replace(/_/g, " ")}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function CategoryPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {CATEGORIES.map((c) => {
        const on = value.includes(c);
        return (
          <button
            type="button"
            key={c}
            onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
            className={cn(
              "flex min-h-12 items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-calm",
              on ? "border-primary bg-ai-soft font-medium" : "border-border hover:bg-accent",
            )}
          >
            {c}
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border",
                on ? "border-primary bg-primary text-primary-foreground" : "border-border",
              )}
            >
              {on && <Check className="size-3" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-xl bg-muted p-1">
      {options.map((o) => (
        <button
          type="button"
          key={String(o)}
          onClick={() => onChange(o)}
          className={cn(
            "min-h-10 min-w-14 rounded-lg px-4 text-sm transition-calm",
            o === value
              ? "bg-card font-medium shadow-soft"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function EmailTimes({
  value,
  onChange,
  tz,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  tz: string;
}) {
  const [draft, setDraft] = useState("12:00");
  const today = dayKey(new Date(), tz);
  const sorted = [...value].sort();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {sorted.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-sm"
          >
            {fmt(fromKeys(today, t, tz), tz, { hour: "numeric", minute: "2-digit" })}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(value.filter((x) => x !== t))}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        {!value.length && (
          <span className="text-sm text-muted-foreground">
            No email times — you won't get emails.
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type="time"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 w-36 rounded-xl"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-xl"
          onClick={() => draft && !value.includes(draft) && onChange([...value, draft])}
        >
          <Plus /> Add time
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Times are in {tz.replace(/_/g, " ")}.</p>
    </div>
  );
}
