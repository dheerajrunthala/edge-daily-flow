// In-app notifications: what a reminder looks like when the tab is already open.
//
// This is a *view of the ledger*, not a fourth delivery channel. check-reminders writes a
// task_notifications row before it sends; Postgres replication hands that row to any tab
// the same user has open. So the toast cannot disagree with what was actually sent, there
// is nothing to schedule in the browser, and a laptop that was asleep shows nothing stale
// on wake — it simply never receives rows it missed.
//
// Everything here is mounted inside AppShell, so it only ever runs for a signed-in user.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { playChime, unlockChime } from "@/lib/chime";
import { clearTabAlert, setTabAlert } from "@/lib/tab-alert";
import { syncSubscription } from "@/lib/push";
import { qk } from "@/lib/queries";

/** A row as replication delivers it — only the ledger's own columns, no task title. */
type LedgerRow = {
  id: string;
  task_id: string;
  due_at: string;
  stage: string;
  channel: string;
  delivered: boolean;
};

/** "nag:3" → "Still open"; the rest read as how far ahead of due they are. */
function describeStage(stage: string): string {
  if (stage.startsWith("nag:")) return "Still open";
  if (stage === "due") return "Due now";
  if (stage === "1h") return "Due in an hour";
  if (stage === "15m") return "Due in 15 minutes";
  return "Coming up";
}

export function NotificationCenter() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [unread, setUnread] = useState(0);

  // One notification can write several ledger rows — one per channel — and they arrive as
  // separate replication events. The user should get one toast, so collapse on what the
  // ledger is actually keyed by.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => unlockChime(), []);

  // Repair an endpoint the push service rotated while the app was closed. Fire and forget.
  useEffect(() => {
    void syncSubscription();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const announce = async (row: LedgerRow) => {
      const key = `${row.task_id}|${row.due_at}|${row.stage}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);

      // The ledger does not carry the title, and the row for a stage that was deliberately
      // not sent (delivered = false, superseded while the function was down) is bookkeeping
      // the user should not be told about.
      if (!row.delivered) return;

      const { data: task } = await supabase
        .from("tasks")
        .select("title, notes, status")
        .eq("id", row.task_id)
        .maybeSingle();
      if (cancelled || !task) return;
      // Completed from a phone or from Telegram in the seconds since — don't nag a tab
      // about something the user has already dealt with.
      if (task.status === "done") return;

      setUnread((n) => n + 1);
      playChime();
      toast(task.title, {
        description: describeStage(row.stage),
        duration: 10_000,
        action: { label: "Open", onClick: () => void navigate({ to: "/tasks" }) },
      });
      // last_reminded_at moved, and a nag means the task is overdue now.
      void qc.invalidateQueries({ queryKey: qk.tasks });
    };

    const channel = supabase
      .channel("task-notifications")
      .on(
        "postgres_changes",
        // No user_id filter needed for correctness — the table's RLS select policy is
        // user_id = auth.uid(), and realtime applies it to this socket's JWT — but it
        // keeps the server from sending rows this tab would only discard.
        { event: "INSERT", schema: "public", table: "task_notifications" },
        (payload) => void announce(payload.new as LedgerRow),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [navigate, qc]);

  // The tab title and favicon carry the count only while the user is looking elsewhere;
  // coming back to the tab *is* reading them.
  useEffect(() => {
    if (unread > 0 && document.visibilityState === "hidden") setTabAlert(unread);
    else clearTabAlert();
  }, [unread]);

  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === "visible") setUnread(0);
    };
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("focus", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("focus", clear);
      clearTabAlert();
    };
  }, []);

  // A Done/Snooze press on a desktop notification is handled in the service worker, which
  // then tells any open tab that its task list is now wrong.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type !== "task-updated") return;
      void qc.invalidateQueries({ queryKey: qk.tasks });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [qc]);

  return null;
}
