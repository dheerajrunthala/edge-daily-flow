import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ExternalLink,
  Loader2,
  Mic,
  MicOff,
  Sparkles,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { AiMark, Card, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAsk, useFeatures, type AgentReply, type AgentTurn } from "@/lib/queries";
import { speechSupported, startDictation, type Dictation } from "@/lib/speech";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/ask")({
  head: () => ({
    meta: [
      { title: "Ask — Daily Edge" },
      {
        name: "description",
        content: "Ask about your news and tasks in your own words.",
      },
    ],
  }),
  component: Ask,
});

const SUGGESTIONS = [
  "What's happened with RBI rates recently?",
  "Anything new on Kubernetes security?",
  "What's overdue?",
  "Summarise my brief in two lines",
];

/** One exchange, kept with its metadata so the reply can show what it did. */
type Exchange = { question: string; reply: AgentReply | null; failed?: boolean };

function Ask() {
  const ask = useAsk();
  const { data: features } = useFeatures();
  const [draft, setDraft] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [listening, setListening] = useState(false);
  const dictation = useRef<Dictation | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const canDictate = speechSupported() && features?.voice !== false;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [exchanges, ask.isPending]);

  // Stop the microphone if the page goes away mid-sentence; a recogniser left running is
  // a recording light the user did not ask for.
  useEffect(() => () => dictation.current?.stop(), []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || ask.isPending) return;

    dictation.current?.stop();
    setListening(false);
    setDraft("");

    // Only completed exchanges become history, so a failed turn does not poison the next.
    const history: AgentTurn[] = exchanges
      .filter((e) => e.reply)
      .flatMap((e) => [
        { role: "user" as const, text: e.question },
        { role: "model" as const, text: e.reply!.answer },
      ]);

    const index = exchanges.length;
    setExchanges((prev) => [...prev, { question, reply: null }]);

    try {
      const reply = await ask.mutateAsync({ message: question, history });
      setExchanges((prev) => prev.map((e, i) => (i === index ? { ...e, reply } : e)));
    } catch {
      setExchanges((prev) => prev.map((e, i) => (i === index ? { ...e, failed: true } : e)));
    }
  };

  const toggleMic = () => {
    if (listening) {
      dictation.current?.stop();
      dictation.current = null;
      setListening(false);
      return;
    }
    const handle = startDictation({
      onText: (text, isFinal) => {
        setDraft(text);
        if (isFinal) setListening(false);
      },
      onError: (message) => {
        toast.error(message);
        setListening(false);
      },
      onEnd: () => setListening(false),
    });
    if (!handle) {
      toast.error("Dictation is not available in this browser.");
      return;
    }
    dictation.current = handle;
    setListening(true);
  };

  if (features && features.chat === false) {
    return (
      <AppShell>
        <PageHeader title="Ask" subtitle="The assistant is turned off for this account." />
        <Card>
          <p className="text-muted-foreground text-sm">
            Turn it back on under Settings → Features.
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Ask"
        subtitle="Your news and tasks, in your own words. Answers cite only what it actually read."
      />

      <div className="space-y-4 pb-36">
        {exchanges.length === 0 && (
          <Card>
            <div className="space-y-3">
              <p className="text-sm">
                <AiMark className="mr-1.5 inline" />
                Ask about anything in your archive. It searches by meaning, so you do not have to
                remember the headline.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="border-border text-muted-foreground hover:text-foreground rounded-full border px-3 py-1.5 text-xs transition-colors"
                    onClick={() => void send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}

        {exchanges.map((exchange, i) => (
          <ExchangeView key={i} exchange={exchange} />
        ))}

        {ask.isPending && (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Reading your news…
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="bg-background/95 border-border fixed inset-x-0 bottom-16 border-t p-3 backdrop-blur lg:bottom-0 lg:left-[var(--sidebar-w,16rem)]">
        <div className="mx-auto flex max-w-[1100px] items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder={listening ? "Listening…" : "Ask about your news or tasks"}
            className="max-h-32 min-h-11 flex-1 resize-none rounded-xl"
          />
          {canDictate && (
            <Button
              variant={listening ? "default" : "outline"}
              size="icon"
              className="size-11 shrink-0 rounded-xl"
              aria-label={listening ? "Stop dictating" : "Dictate"}
              onClick={toggleMic}
            >
              {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
          )}
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-xl"
            aria-label="Send"
            disabled={!draft.trim() || ask.isPending}
            onClick={() => void send(draft)}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </AppShell>
  );
}

function ExchangeView({ exchange }: { exchange: Exchange }) {
  const { question, reply, failed } = exchange;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <p className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm">
          {question}
        </p>
      </div>

      {failed && (
        <p className="text-muted-foreground px-1 text-sm">
          That one did not go through. Try again.
        </p>
      )}

      {reply && (
        <Card>
          <div className="space-y-3">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{reply.answer}</p>

            {reply.citations.length > 0 && (
              <ul className="space-y-1.5 border-t pt-3">
                {reply.citations.map((c) => (
                  <li key={c.url}>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-baseline gap-2 text-xs"
                    >
                      <ExternalLink className="text-muted-foreground mt-0.5 size-3 shrink-0" />
                      <span className="group-hover:text-primary flex-1 underline-offset-2 group-hover:underline">
                        {c.title}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {c.via_google_news ? "via Google News" : c.source}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {reply.unverified_links.length > 0 && (
              <p className="text-destructive flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {reply.unverified_links.length} link
                  {reply.unverified_links.length === 1 ? "" : "s"} above did not come from anything
                  it read. Treat {reply.unverified_links.length === 1 ? "it" : "them"} as
                  unverified.
                </span>
              </p>
            )}

            <Trace reply={reply} />
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * What the assistant actually did.
 *
 * Shown rather than hidden because the alternative is asking the user to trust prose. A
 * mutating call is marked, so "I've added that" can be checked against whether a write
 * really happened.
 */
function Trace({ reply }: { reply: AgentReply }) {
  if (reply.tool_calls.length === 0) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
      <Wrench className="size-3" />
      {reply.tool_calls.map((call, i) => (
        <span
          key={i}
          className={cn(
            "border-border rounded-full border px-2 py-0.5",
            !call.ok && "border-destructive/40 text-destructive",
            call.mutating && call.ok && "border-primary/40 text-primary",
          )}
          title={call.error ?? `${call.duration_ms}ms`}
        >
          {call.name}
          {call.mutating && call.ok ? " ✓" : ""}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-1">
        <Sparkles className="size-3" />
        {reply.quota.limit - reply.quota.used} left today
      </span>
    </div>
  );
}
