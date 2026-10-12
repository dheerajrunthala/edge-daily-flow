import { Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <img src="/icon-192.png" alt="" width={24} height={24} className="size-6 rounded-md" />
      Daily Edge
    </span>
  );
}

export function TagChip({
  name,
  color,
  className,
}: {
  name: string;
  color?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "tag-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        `tag-${color ?? "slate"}`,
        className,
      )}
    >
      {name}
    </span>
  );
}

export function AiMark({ className }: { className?: string }) {
  return <Sparkles className={cn("size-3.5 text-ai", className)} aria-label="AI generated" />;
}

export function Card({
  className,
  children,
  ai,
}: {
  className?: string;
  children: ReactNode;
  ai?: boolean | undefined;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl bg-card text-card-foreground shadow-soft",
        ai ? "ai-border" : "border border-border",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  icon: Icon,
  tone,
  action,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  tone?: "overdue" | "ai" | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2
        className={cn(
          "flex items-center gap-2 text-sm font-semibold",
          tone === "overdue" && "text-overdue",
          tone === "ai" && "text-ai",
        )}
      >
        {Icon && <Icon className="size-4" />}
        {children}
      </h2>
      {action}
    </div>
  );
}

export function EmptyState({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
