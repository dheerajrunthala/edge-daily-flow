import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Check, ExternalLink, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Segmented } from "@/components/pref-controls";
import {
  qk,
  useNotifyPrefs,
  usePushSubscriptions,
  useTelegramActions,
  useTelegramLink,
  useUpdateNotifyPrefs,
  type NotifyChannel,
} from "@/lib/queries";
import {
  disablePush,
  enablePush,
  permissionNow,
  pushState,
  pushSupported,
  testPush,
  type PushState,
} from "@/lib/push";
import { TELEGRAM_BOT, telegramDeepLink } from "@/lib/telegram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListSkeleton } from "@/components/common";
import { Switch } from "@/components/ui/switch";

/** The nag cadences worth offering. The column allows anything from 1 min to 24 hours. */
const NAG_MINUTES = [5, 15, 30, 60] as const;

/** Postgres `time`/`interval` arrive as "HH:MM:SS"; the time input wants "HH:MM". */
const toClock = (value: string | null | undefined) => (value ?? "").slice(0, 5);

function nagToMinutes(interval: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(interval ?? "");
  if (!m) return 15;
  return Number(m[1]) * 60 + Number(m[2]);
}

const minutesToInterval = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;

export function NotificationSettings() {
  const { data: prefs } = useNotifyPrefs();
  const update = useUpdateNotifyPrefs();
  const { connect, unlink } = useTelegramActions();
  const push = usePush();

  // A fresh code is only useful until it is used; while one is outstanding, poll for the
  // webhook having consumed it so the UI flips to "Connected" on its own.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const { data: link } = useTelegramLink(pendingCode !== null);
  const linked = !!link?.chat_id;

  useEffect(() => {
    if (linked && pendingCode) {
      setPendingCode(null);
      toast.success("Telegram connected");
    }
  }, [linked, pendingCode]);

  if (!prefs) return <ListSkeleton rows={4} />;

  const channels = prefs.channels ?? [];
  const has = (c: NotifyChannel) => channels.includes(c);
  const setChannel = (c: NotifyChannel, on: boolean) =>
    update.mutate({
      channels: on ? [...channels.filter((x) => x !== c), c] : channels.filter((x) => x !== c),
    });

  const quietOff = toClock(prefs.quiet_start) === toClock(prefs.quiet_end);

  const startConnect = () =>
    connect.mutate(undefined, {
      onSuccess: (row) => {
        setPendingCode(row.code);
        // Popup blockers eat this sometimes, which is why the link is also rendered below.
        window.open(telegramDeepLink(row.code), "_blank", "noopener,noreferrer");
      },
    });

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <ChannelRow
          label="Email"
          hint="Goes to your account email."
          checked={has("email")}
          onChange={(v) => setChannel("email", v)}
        />
        <ChannelRow
          label="Telegram"
          hint={linked ? `Connected to @${TELEGRAM_BOT}` : "Connect below to use this."}
          checked={has("telegram")}
          disabled={!linked}
          onChange={(v) => setChannel("telegram", v)}
        />
        <ChannelRow
          label="Desktop push"
          hint={
            push.devices > 0
              ? `On in ${push.devices} browser${push.devices === 1 ? "" : "s"}.`
              : "Turn it on for this browser below."
          }
          checked={has("push")}
          disabled={push.devices === 0}
          onChange={(v) => setChannel("push", v)}
        />
      </div>

      <div className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Send className="size-4 shrink-0" /> Telegram bot
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {linked
                ? "Reminders arrive with Done / Snooze / Tomorrow buttons. Message the bot to add tasks."
                : `Chat with @${TELEGRAM_BOT} to add tasks and act on reminders.`}
            </p>
          </div>
          {linked ? (
            <Button
              variant="outline"
              className="h-10 shrink-0 rounded-xl"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              {unlink.isPending && <Loader2 className="animate-spin" />} Disconnect
            </Button>
          ) : (
            <Button
              className="h-10 shrink-0 rounded-xl"
              disabled={connect.isPending}
              onClick={startConnect}
            >
              {connect.isPending ? <Loader2 className="animate-spin" /> : <Send />} Connect Telegram
            </Button>
          )}
        </div>

        {linked && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" /> Connected. Send <code>/help</code> in the chat to see
            what it can do.
          </p>
        )}

        {!linked && pendingCode && (
          <div className="mt-3 space-y-1.5 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              Waiting for Telegram… if nothing opened, use this link (good for 15 minutes):
            </p>
            <a
              href={telegramDeepLink(pendingCode)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Open @{TELEGRAM_BOT} <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
      </div>

      <DesktopPush push={push} />

      <div className="space-y-2">
        <Label>Quiet hours</Label>
        <div className="flex items-center gap-2">
          <Input
            type="time"
            aria-label="Quiet hours start"
            value={toClock(prefs.quiet_start)}
            onChange={(e) => e.target.value && update.mutate({ quiet_start: e.target.value })}
            className="h-11 w-32 rounded-xl"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="time"
            aria-label="Quiet hours end"
            value={toClock(prefs.quiet_end)}
            onChange={(e) => e.target.value && update.mutate({ quiet_end: e.target.value })}
            className="h-11 w-32 rounded-xl"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {quietOff
            ? "Set to the same time — nothing is held back."
            : "Nothing is sent during these hours; the escalation picks up again afterwards. Set both to the same time to switch quiet hours off."}
        </p>
      </div>

      <div className="space-y-2">
        <Label>Repeat while overdue</Label>
        <div>
          <Segmented
            options={NAG_MINUTES.map((m) => (m === 60 ? "1 hr" : `${m} min`))}
            value={
              nagToMinutes(prefs.nag_interval) === 60
                ? "1 hr"
                : `${nagToMinutes(prefs.nag_interval)} min`
            }
            onChange={(label) => {
              const mins = label === "1 hr" ? 60 : Number(label.replace(" min", ""));
              update.mutate({ nag_interval: minutesToInterval(mins) });
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          How often an overdue task pings you again, until it's done or snoozed.
        </p>
      </div>
    </div>
  );
}

/**
 * Everything the Settings card needs to know about push, in one place.
 *
 * Two sources of truth, deliberately kept separate: `permission`/`subscribed` are facts
 * about *this* browser that only the browser can answer, and `devices` is the account-wide
 * row count from the database. A user can be subscribed on their phone (devices = 1) while
 * this laptop has never asked (subscribed = false), and the UI has to show both.
 */
function usePush() {
  const qc = useQueryClient();
  const { data: subs } = usePushSubscriptions();
  const [state, setState] = useState<PushState>({
    supported: true,
    permission: "default",
    subscribed: false,
    configured: null,
  });
  const [busy, setBusy] = useState<null | "enable" | "disable" | "test">(null);

  const refresh = useCallback(async () => {
    setState(await pushState());
    void qc.invalidateQueries({ queryKey: qk.pushSubs });
    // Subscribing switches the `push` channel on server-side, so the toggles above have
    // to be re-read rather than left showing the pre-click state.
    void qc.invalidateQueries({ queryKey: qk.notifyPrefs });
  }, [qc]);

  useEffect(() => {
    if (!pushSupported()) {
      setState({ supported: false, permission: "denied", subscribed: false, configured: null });
      return;
    }
    void pushState().then(setState);
  }, []);

  const run =
    (kind: "enable" | "disable" | "test", fn: () => Promise<unknown>, ok: string) => async () => {
      setBusy(kind);
      try {
        await fn();
        toast.success(ok);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusy(null);
        await refresh();
      }
    };

  return {
    ...state,
    // Read live rather than from state: the user may have changed the site permission in
    // browser settings since this component mounted.
    permission: state.supported ? permissionNow() : ("denied" as NotificationPermission),
    devices: subs?.length ?? 0,
    busy,
    enable: run("enable", enablePush, "Desktop notifications are on"),
    disable: run("disable", disablePush, "Desktop notifications turned off"),
    test: run("test", testPush, "Test notification sent"),
  };
}

type Push = ReturnType<typeof usePush>;

/**
 * The "Enable desktop notifications" card. Four states worth distinguishing, because the
 * fix is different in each: unsupported browser, blocked at the browser level (which the
 * app cannot undo — only site settings can), not yet asked, and on.
 */
function DesktopPush({ push }: { push: Push }) {
  const blocked = push.permission === "denied" && push.supported;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {push.subscribed ? (
              <Bell className="size-4 shrink-0" />
            ) : (
              <BellOff className="size-4 shrink-0" />
            )}
            Desktop notifications
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {push.subscribed
              ? "Reminders show up on your desktop with Done and Snooze buttons — even with Daily Edge closed."
              : "Get reminders on your desktop even when this tab is closed."}
          </p>
        </div>

        {push.supported && !blocked && (
          <Button
            variant={push.subscribed ? "outline" : "default"}
            className="h-10 shrink-0 rounded-xl"
            disabled={push.busy !== null}
            onClick={push.subscribed ? push.disable : push.enable}
          >
            {push.busy === "enable" || push.busy === "disable" ? (
              <Loader2 className="animate-spin" />
            ) : push.subscribed ? (
              <BellOff />
            ) : (
              <Bell />
            )}
            {push.subscribed ? "Turn off" : "Enable"}
          </Button>
        )}
      </div>

      {push.subscribed && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-xl"
            disabled={push.busy !== null}
            onClick={push.test}
          >
            {push.busy === "test" ? <Loader2 className="animate-spin" /> : <Send />} Send a test
            notification
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" /> On in this browser
          </span>
        </div>
      )}

      {!push.supported && (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          This browser doesn't support desktop notifications. On iPhone and iPad, add Daily Edge to
          your Home Screen first — Safari only allows them for installed web apps.
        </p>
      )}

      {blocked && (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          Notifications are <strong>blocked</strong> for this site, so the app can't ask again.
          Allow them in your browser's site settings (in Chrome: the icon to the left of the address
          bar → Notifications → Allow), then reload this page.
        </p>
      )}

      {/*
        Worth saying out loud: on macOS, Chrome's default notification style is "Banners",
        which auto-dismisses after a few seconds and throws away the Done/Snooze buttons.
        requireInteraction is honoured only under "Alerts", so a reminder the user is
        meant to act on is invisible until this is changed.
      */}
      {push.supported && !blocked && (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          <strong>On a Mac:</strong> open System Settings → Notifications → Google Chrome and set
          the alert style to <strong>Alerts</strong> rather than Banners. Banners disappear after a
          few seconds and hide the Done / Snooze buttons.
        </p>
      )}
    </div>
  );
}

function ChannelRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}
