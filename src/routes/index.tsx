import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bell,
  BellOff,
  BellRing,
  Bot,
  Calendar,
  CalendarCheck,
  Check,
  Linkedin,
  Link2,
  Mail,
  Menu,
  Mic,
  Monitor,
  MessageSquare,
  Moon,
  Newspaper,
  Rss,
  Send,
  Sparkles,
  Sun,
  Terminal,
  Wand2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { AiMark, Card, Logo, TagChip } from "@/components/common";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Daily Edge — Switch contexts freely. Drop nothing." },
      {
        name: "description",
        content:
          "A command center for AI-enabled professionals: tasks captured from Claude Code, Telegram or plain English, a daily AI news digest, and reminders that won't let anything slip.",
      },
      { property: "og:title", content: "Daily Edge — Switch contexts freely. Drop nothing." },
      {
        property: "og:description",
        content:
          "A command center for AI-enabled professionals: tasks captured from Claude Code, Telegram or plain English, a daily AI news digest, and reminders that won't let anything slip.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

/** Fades a section up into place the first time it enters the viewport; a no-op under reduced motion. */
function Reveal({
  children,
  className,
  delay,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        el.classList.add("is-visible");
        observer.disconnect();
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cn("reveal", className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** Resolves the theme context's `system | light | dark` pref to the boolean the toggle icon needs. */
function useIsDark() {
  const { theme } = useTheme();
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const compute = () =>
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setIsDark(compute());
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setIsDark(compute());
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [theme]);
  return isDark;
}

function ThemeToggle({ className }: { className?: string }) {
  const { setTheme } = useTheme();
  const isDark = useIsDark();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("rounded-xl", className)}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-5" /> : <Moon className="size-5" />}
      <span className="sr-only">{isDark ? "Switch to light mode" : "Switch to dark mode"}</span>
    </Button>
  );
}

const NAV_LINKS = [
  { id: "features", label: "Features" },
  { id: "how-it-works", label: "How it works" },
  { id: "integrations", label: "Integrations" },
  { id: "about", label: "About" },
];

const PROBLEMS = [
  {
    icon: Workflow,
    title: "Thoughts get lost mid-flow",
    body: "You realize you need to come back to something deep in other work, and capturing it breaks your focus.",
  },
  {
    icon: Rss,
    title: "Learning is another distraction",
    body: "Keeping up with AI and tech means scrolling dozens of noisy sources just to find what matters.",
  },
  {
    icon: BellOff,
    title: "Tools wait to be checked",
    body: "One dismissible notification can't compete with ten parallel threads for your attention.",
  },
];

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Wand2,
    title: "Plain-English tasks",
    body: "“review Ankit's PR Thursday 4pm #project-x” becomes a dated, tagged task. Recurring tasks and birthdays included.",
  },
  {
    icon: Newspaper,
    title: "AI news digest",
    body: "~40 vetted sources, duplicates and clickbait removed, ~950 daily items distilled into your top 10/20/30 stories, each with a “why it matters to you” line and a link to the source.",
  },
  {
    icon: Link2,
    title: "Story follow-ups",
    body: "AI links today's news to earlier coverage, so you follow how a story develops instead of re-reading the same headline.",
  },
  {
    icon: BellRing,
    title: "Reminders that escalate",
    body: "Heads-up, 1 hour, 15 minutes, due, then nudges until it's done, across email, Telegram and desktop push. Quiet hours keep your evenings yours.",
  },
  {
    icon: Mail,
    title: "Morning brief",
    body: "Every open thread across projects plus your news digest, in your inbox at 8 AM.",
  },
];

const STEPS = [
  {
    icon: Terminal,
    title: "Capture",
    body: "From Claude Code, Telegram, or the web app — whichever is already open.",
  },
  {
    icon: Newspaper,
    title: "Stay informed",
    body: "Your AI digest is ready each morning, distilled from the sources you follow.",
  },
  {
    icon: BellRing,
    title: "Never slip",
    body: "Escalating reminders with one-tap Done and Snooze, wherever you'll actually see them.",
  },
];

const INTEGRATIONS_LIVE = [
  { icon: Terminal, name: "Claude Code", note: "MCP server" },
  { icon: Monitor, name: "Claude Desktop", note: "MCP server" },
  { icon: Send, name: "Telegram", note: "bot + reminders" },
  { icon: Mail, name: "Email", note: "digest + reminders" },
  { icon: Bell, name: "Desktop push", note: "browser notifications" },
];

const INTEGRATIONS_SOON = [
  { icon: MessageSquare, name: "WhatsApp" },
  { icon: Mic, name: "Amazon Alexa" },
  { icon: Bot, name: "Google Assistant / Gemini" },
  { icon: Calendar, name: "Google Calendar" },
];

const STACK_CHIPS = [
  "React",
  "TypeScript",
  "Supabase",
  "Postgres + pgvector",
  "Gemini",
  "MCP",
  "Telegram Bot API",
  "Web Push",
];

function Landing() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/brief", replace: true });
    });
  }, [navigate]);

  const handleNav = (id: string) => {
    setMenuOpen(false);
    scrollToId(id);
  };

  return (
    <div className="min-h-dvh bg-background bg-hero">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center justify-between px-4 md:px-8">
          <Logo />
          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  handleNav(l.id);
                }}
                className="text-sm text-muted-foreground transition-calm hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="hidden items-center gap-2 md:flex">
              <Button asChild variant="ghost" className="rounded-xl">
                <Link to="/login">Sign in</Link>
              </Button>
              <Button asChild className="rounded-xl">
                <Link to="/login">Get started</Link>
              </Button>
            </div>
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-xl md:hidden">
                  <Menu className="size-5" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="flex w-full flex-col gap-1 sm:max-w-xs">
                <SheetHeader className="flex-row items-center justify-between space-y-0">
                  <SheetTitle>
                    <Logo />
                  </SheetTitle>
                  <ThemeToggle className="mr-6" />
                </SheetHeader>
                <nav className="mt-4 flex flex-col gap-1">
                  {NAV_LINKS.map((l) => (
                    <a
                      key={l.id}
                      href={`#${l.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        handleNav(l.id);
                      }}
                      className="rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition-calm hover:bg-accent"
                    >
                      {l.label}
                    </a>
                  ))}
                </nav>
                <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
                  <SheetClose asChild>
                    <Button asChild variant="outline" className="rounded-xl">
                      <Link to="/login">Sign in</Link>
                    </Button>
                  </SheetClose>
                  <SheetClose asChild>
                    <Button asChild className="rounded-xl">
                      <Link to="/login">Get started</Link>
                    </Button>
                  </SheetClose>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <Hero />
      <ProblemStrip />
      <Features />
      <HowItWorks />
      <Integrations />
      <BuiltWithAi />
      <AboutCreator />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative mx-auto max-w-[1100px] px-4 pb-16 pt-14 text-center md:px-8 md:pt-24">
      <Reveal>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <AiMark /> For the AI-enabled professional
        </span>
      </Reveal>
      <Reveal delay={80}>
        <h1 className="mx-auto mt-6 max-w-3xl font-serif text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl md:text-7xl">
          Switch contexts freely. Drop nothing.
        </h1>
      </Reveal>
      <Reveal delay={160}>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground md:text-lg">
          AI lets you run more projects, agents and learning threads than ever. Daily Edge keeps
          track of all of it: tasks captured from your code editor, chat, or plain English, a daily
          AI news digest, and reminders that won't let anything slip.
        </p>
      </Reveal>
      <Reveal delay={240}>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="h-12 w-full rounded-xl px-6 text-base sm:w-auto">
            <Link to="/login">
              Get started free <ArrowRight />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="h-12 w-full rounded-xl px-6 text-base sm:w-auto"
            onClick={() => scrollToId("how-it-works")}
          >
            See how it works
          </Button>
        </div>
      </Reveal>
      <Reveal delay={320} className="mt-16">
        <div className="landing-float">
          <ProductMock />
        </div>
      </Reveal>
    </section>
  );
}

function ProductMock() {
  return (
    <div className="relative mx-auto max-w-4xl text-left">
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
              RBI holds rates steady while Nifty IT rallies on strong deal wins. A new open-weights
              model tops coding benchmarks — worth a look before your 3pm architecture review.
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

      <div className="absolute -bottom-7 right-4 w-[13.5rem] translate-y-1/2 sm:right-8 sm:w-60 md:-bottom-9 md:right-10">
        <div className="rounded-2xl border border-border bg-card p-3 shadow-soft">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden>⏰</span> Due in 15 min: Review PR #42
          </p>
          <div className="mt-2.5 flex gap-2">
            <span className="flex-1 rounded-lg bg-primary px-2 py-1 text-center text-[11px] font-medium text-primary-foreground">
              Done
            </span>
            <span className="flex-1 rounded-lg border border-border px-2 py-1 text-center text-[11px] font-medium text-muted-foreground">
              Snooze
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProblemStrip() {
  return (
    <section className="mx-auto max-w-[1100px] px-4 pb-20 md:px-8">
      <div className="grid gap-4 md:grid-cols-3">
        {PROBLEMS.map((p, i) => (
          <Reveal key={p.title} delay={i * 80}>
            <Card className="h-full p-6">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <p.icon className="size-5 text-muted-foreground" />
              </div>
              <h3 className="mt-4 font-semibold">{p.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto max-w-[1100px] px-4 py-20 md:px-8">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-serif text-3xl font-medium tracking-tight md:text-4xl">
          Everything that keeps you from dropping the ball
        </h2>
        <p className="mt-3 text-muted-foreground">
          Capture, context and reminders, built for the way AI-assisted work actually happens.
        </p>
      </Reveal>

      <Reveal delay={80} className="mt-10">
        <Card ai className="grid gap-6 p-6 md:grid-cols-[1fr_1.1fr] md:p-8">
          <div className="flex flex-col justify-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-ai-soft">
              <Terminal className="size-5 text-ai" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">Capture from your code editor</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              A custom MCP server connects Claude Code and Claude Desktop. Say "remind me tomorrow
              morning to finish this migration" and AI creates the task with project, files and next
              step filled in.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl bg-[#0c0c10] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300 shadow-soft">
            <div className="mb-2.5 flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
            </div>
            <p className="text-zinc-500">$ claude</p>
            <p className="mt-2">
              <span className="text-zinc-500">you ·</span> remind me tomorrow morning to finish the
              migration
            </p>
            <p className="mt-2 text-emerald-400">
              ✓ created "Finish the migration" — due tomorrow 9:00 AM
            </p>
            <p className="text-zinc-500">
              tags: Coding, edge-daily-flow · notes: Project: edge-daily-flow · Next: run
              apply_migration and verify
            </p>
          </div>
        </Card>
      </Reveal>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 60}>
            <Card className="h-full p-6">
              <div className="flex size-10 items-center justify-center rounded-xl bg-ai-soft">
                <f.icon className="size-5 text-ai" />
              </div>
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-[1100px] px-4 py-20 md:px-8">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-serif text-3xl font-medium tracking-tight md:text-4xl">How it works</h2>
      </Reveal>
      <div className="relative mt-12 grid gap-8 md:grid-cols-3 md:gap-6">
        <div aria-hidden className="absolute left-0 right-0 top-5 hidden h-px bg-border md:block" />
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 100} className="relative text-center md:text-left">
            <div className="relative z-10 mx-auto flex size-10 items-center justify-center rounded-full border border-border bg-background shadow-soft md:mx-0">
              <s.icon className="size-5 text-ai" />
            </div>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Step {i + 1}
            </p>
            <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Integrations() {
  return (
    <section id="integrations" className="mx-auto max-w-[1100px] px-4 py-20 md:px-8">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-serif text-3xl font-medium tracking-tight md:text-4xl">
          Meets you where you already are
        </h2>
        <p className="mt-3 text-muted-foreground">
          Capture and reminders across the tools you actually keep open.
        </p>
      </Reveal>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {INTEGRATIONS_LIVE.map((it, i) => (
          <Reveal key={it.name} delay={i * 50}>
            <Card className="h-full p-5">
              <div className="flex items-center justify-between">
                <div className="flex size-10 items-center justify-center rounded-xl bg-ai-soft">
                  <it.icon className="size-5 text-ai" />
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <span className="size-1.5 rounded-full bg-success" /> Live
                </span>
              </div>
              <h3 className="mt-4 text-sm font-semibold">{it.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{it.note}</p>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal delay={100} className="mt-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {INTEGRATIONS_SOON.map((it) => (
            <Card key={it.name} className="h-full p-5 opacity-70">
              <div className="flex items-center justify-between">
                <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
                  <it.icon className="size-5 text-muted-foreground" />
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 text-[11px] font-medium text-ai">
                  Coming soon
                </span>
              </div>
              <h3 className="mt-4 text-sm font-semibold">{it.name}</h3>
            </Card>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function BuiltWithAi() {
  return (
    <section className="mx-auto max-w-[1100px] px-4 py-20 md:px-8">
      <Reveal>
        <Card ai className="p-6 text-center md:p-10">
          <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-ai-soft">
            <Sparkles className="size-5 text-ai" />
          </div>
          <h2 className="mt-4 font-serif text-2xl font-medium tracking-tight md:text-3xl">
            Built with AI
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
            Daily Edge was built the way it's meant to be used. The interface was designed with
            Lovable; the backend, data pipelines and integrations were engineered with Claude Code
            operating Supabase through MCP. Weeks of work, delivered in days.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {STACK_CHIPS.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
              >
                {chip}
              </span>
            ))}
          </div>
        </Card>
      </Reveal>
    </section>
  );
}

function AboutCreator() {
  return (
    <section id="about" className="mx-auto max-w-[1100px] px-4 py-20 md:px-8">
      <Reveal>
        <Card className="mx-auto flex max-w-2xl flex-col items-center gap-4 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">
            DR
          </div>
          <div>
            <h2 className="text-lg font-semibold">Made by Dheeraj Runthala</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Software engineer building AI-first tools for focused, high-output work.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon" className="rounded-xl">
              <a
                href="https://www.linkedin.com/in/dheeraj-runthala/"
                target="_blank"
                rel="noreferrer"
              >
                <Linkedin className="size-4" />
                <span className="sr-only">LinkedIn</span>
              </a>
            </Button>
            <Button asChild variant="outline" size="icon" className="rounded-xl">
              <a href="mailto:dheerajrunthala.7@gmail.com">
                <Mail className="size-4" />
                <span className="sr-only">Email</span>
              </a>
            </Button>
          </div>
        </Card>
      </Reveal>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-[1100px] px-4 py-16 md:px-8">
      <Reveal>
        <div className="rounded-3xl border border-border bg-card px-6 py-14 text-center shadow-soft md:py-20">
          <h2 className="mx-auto max-w-xl font-serif text-3xl font-medium tracking-tight md:text-5xl">
            Take on more. Drop nothing.
          </h2>
          <div className="mt-8 flex justify-center">
            <Button asChild size="lg" className="h-12 rounded-xl px-6 text-base">
              <Link to="/login">
                Get started free <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-[1100px] flex-col items-center justify-between gap-4 px-4 py-8 text-sm md:flex-row md:px-8">
        <p className="text-muted-foreground">
          © {new Date().getFullYear()} Daily Edge · Made with ♥ by Dheeraj Runthala
        </p>
        <nav className="flex items-center gap-5 text-muted-foreground">
          <a
            href="#features"
            onClick={(e) => {
              e.preventDefault();
              scrollToId("features");
            }}
            className="transition-calm hover:text-foreground"
          >
            Features
          </a>
          <a
            href="#integrations"
            onClick={(e) => {
              e.preventDefault();
              scrollToId("integrations");
            }}
            className="transition-calm hover:text-foreground"
          >
            Integrations
          </a>
          <Link to="/login" className="transition-calm hover:text-foreground">
            Sign in
          </Link>
        </nav>
      </div>
    </footer>
  );
}
