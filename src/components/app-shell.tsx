import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  CheckSquare,
  MessageCircle,
  LogOut,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "./common";
import { NotificationCenter } from "./notification-center";
import { supabase } from "@/integrations/supabase/client";
import { useProfile } from "@/lib/queries";

const NAV = [
  { to: "/brief", label: "Brief", icon: Sun },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/ask", label: "Ask", icon: MessageCircle },
  { to: "/insights", label: "Insights", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/login", replace: true });
  };
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { data: profile } = useProfile();
  const signOut = useSignOut();

  useEffect(() => {
    setCollapsed(localStorage.getItem("sidebar") === "collapsed");
  }, []);
  const toggle = () => {
    localStorage.setItem("sidebar", collapsed ? "open" : "collapsed");
    setCollapsed(!collapsed);
  };

  return (
    <div className="min-h-dvh bg-background">
      {/* Renders nothing; mounted here so every signed-in page gets live reminders. */}
      <NotificationCenter />

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar transition-calm lg:flex",
          collapsed ? "w-[68px]" : "w-60",
        )}
      >
        <div className="flex h-16 items-center justify-between px-4">
          {!collapsed && <Logo className="text-sm" />}
          <button
            onClick={toggle}
            className="rounded-lg p-2 text-muted-foreground transition-calm hover:bg-sidebar-accent hover:text-foreground"
            aria-label="Toggle sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={n.label}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-calm hover:bg-sidebar-accent hover:text-foreground"
              activeProps={{ className: "bg-sidebar-accent text-foreground font-medium" }}
            >
              <n.icon className="size-4 shrink-0" />
              {!collapsed && n.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          {!collapsed && profile?.full_name && (
            <p className="truncate px-3 pb-2 text-xs text-muted-foreground">{profile.full_name}</p>
          )}
          <button
            onClick={signOut}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-calm hover:bg-sidebar-accent hover:text-foreground"
          >
            <LogOut className="size-4 shrink-0" />
            {!collapsed && "Sign out"}
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border bg-background/85 px-4 backdrop-blur lg:hidden">
        <Logo className="text-sm" />
      </header>

      <main className={cn("transition-calm", collapsed ? "lg:pl-[68px]" : "lg:pl-60")}>
        <div className="mx-auto w-full max-w-[1100px] px-4 pb-28 pt-6 md:px-8 lg:pb-16 lg:pt-10">
          {children}
        </div>
      </main>

      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 pb-safe backdrop-blur lg:hidden">
        <div className="grid grid-cols-5">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground transition-calm"
              activeProps={{ className: "text-primary font-medium" }}
            >
              <n.icon className="size-5" />
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
