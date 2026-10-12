import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ArrowRight, CalendarCheck, Check, Mail, Newspaper, Sparkles, Wand2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AiMark, Card, Logo, TagChip } from "@/components/common";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Daily Edge — Your day, distilled by AI" },
      {
        name: "description",
        content: "AI-organized tasks and a personalized daily news brief, delivered to your inbox every morning.",
      },
      { property: "og:title", content: "Daily Edge — Your day, distilled by AI" },
      {
        property: "og:description",
        content: "AI-organized tasks and a personalized daily news brief, delivered to your inbox every morning.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    icon: Wand2,
    title: "Natural-language tasks",
    body: "Type “call Rahul next Tue 3pm #office” and AI turns it into a dated, tagged task.",
  },
  {
    icon: Newspaper,
    title: "Daily AI news digest",
    body: "Headlines from the topics you care about, ranked and summarized with why they matter.",
  },
  {
    icon: Mail,
    title: "Morning email brief",
    body: "Your tasks and top stories land in your inbox at the times you choose.",
  },
];

function Landing() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/brief", replace: true });
    });
  }, [navigate]);

  return (
    <div className="min-h-dvh bg-background bg-hero">
      <header className="mx-auto flex h-16 max-w-[1100px] items-center justify-between px-4 md:px-8">
        <Logo />
        <Button asChild variant="ghost" className="rounded-xl">
          <Link to="/login">Sign in</Link>
        </Button>
      </header>

      <section className="mx-auto max-w-[1100px] px-4 pb-16 pt-14 text-center md:px-8 md:pt-24">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <AiMark /> AI that plans your day and reads the news for you
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl font-serif text-5xl font-medium leading-[1.05] tracking-tight md:text-7xl">
          Your day, distilled by AI.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground md:text-lg">
          Tasks organized from plain sentences, and a personalized daily news brief waiting in your inbox each
          morning.
        </p>
        <div className="mt-8 flex justify-center">
          <Button asChild size="lg" className="h-12 rounded-xl px-6 text-base">
            <Link to="/login">
              Get started <ArrowRight />
            </Link>
          </Button>
        </div>

        <ProductMock />
      </section>

      <section className="mx-auto grid max-w-[1100px] gap-4 px-4 pb-24 md:grid-cols-3 md:px-8">
        {FEATURES.map((f) => (
          <Card key={f.title} className="p-6 text-left">
            <div className="flex size-10 items-center justify-center rounded-xl bg-ai-soft">
              <f.icon className="size-5 text-ai" />
            </div>
            <h3 className="mt-4 font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
          </Card>
        ))}
      </section>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Daily Edge
      </footer>
    </div>
  );
}

function ProductMock() {
  return (
    <div className="relative mx-auto mt-16 max-w-4xl text-left">
      <div className="rounded-3xl border border-border bg-card p-3 shadow-soft md:p-4">
        <div className="mb-3 flex items-center gap-1.5 px-2">
          <span className="size-2.5 rounded-full bg-muted" />
          <span className="size-2.5 rounded-full bg-muted" />
          <span className="size-2.5 rounded-full bg-muted" />
        </div>
        <div className="grid gap-3 md:grid-cols-[1.3fr_1fr]">
          <Card ai className="p-5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ai">
              <AiMark /> Today at a glance
            </p>
            <p className="mt-3 font-serif text-lg leading-snug">
              RBI holds rates steady while Nifty IT rallies on strong deal wins. A new open-weights model tops coding
              benchmarks — worth a look before your 3pm architecture review.
            </p>
            <div className="mt-5 space-y-3 border-t border-border pt-4">
              {[
                ["Open-weights model beats GPT-class on SWE-bench", "AI"],
                ["Sensex closes 400 pts higher as IT leads", "Markets"],
              ].map(([h, c]) => (
                <div key={h}>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{c}</p>
                  <p className="font-serif text-base">{h}</p>
                </div>
              ))}
            </div>
          </Card>
          <div className="space-y-3">
            <Card className="p-4">
              <p className="mb-3 text-xs font-semibold">Today</p>
              {[
                ["Architecture review", "3:00 pm", "Office", "blue"],
                ["Pay credit card bill", "6:00 pm", "Finance", "amber"],
                ["Evening run", "7:30 pm", "Health", "cyan"],
              ].map(([t, time, tag, color], i) => (
                <div key={t} className="flex items-center gap-3 py-2">
                  <span
                    className={`flex size-4 items-center justify-center rounded-full border ${i === 2 ? "border-primary bg-primary" : "border-border"}`}
                  >
                    {i === 2 && <Check className="size-3 text-primary-foreground" />}
                  </span>
                  <span className="flex-1 text-sm">{t}</span>
                  <TagChip name={tag ?? ""} color={color} />
                  <span className="text-xs text-muted-foreground">{time}</span>
                </div>
              ))}
            </Card>
            <Card className="flex items-center gap-3 p-4">
              <CalendarCheck className="size-5 text-overdue" />
              <div className="text-sm">
                <p className="font-medium">Mom's birthday</p>
                <p className="text-xs text-muted-foreground">in 3 days · every year</p>
              </div>
              <Sparkles className="ml-auto size-4 text-ai" />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
