import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Segmented } from "@/components/pref-controls";
import {
  useNotifyPrefs,
  useTelegramActions,
  useTelegramLink,
  useUpdateNotifyPrefs,
  type NotifyChannel,
} from "@/lib/queries";
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
          label="Push"
          hint="Browser push — coming with the PWA."
          checked={false}
          disabled
          onChange={() => {}}
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
