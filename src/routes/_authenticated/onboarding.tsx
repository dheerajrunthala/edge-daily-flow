import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { browserTimezone } from "@/lib/tz";
import { CATEGORIES, qk, usePrefs, useProfile } from "@/lib/queries";
import { Card, Logo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CategoryPicker, EmailTimes, Segmented, TimezoneSelect } from "@/components/pref-controls";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Welcome — Daily Edge" },
      { name: "description", content: "Set up your Daily Edge brief in three quick steps." },
      { property: "og:title", content: "Welcome — Daily Edge" },
      { property: "og:description", content: "Set up your Daily Edge brief in three quick steps." },
    ],
  }),
  component: Onboarding,
});

const STEPS = ["About you", "Interests", "Email brief"];
const EXAMPLE = "Software engineer in India interested in AI, backend, and markets";
const DEFAULT_TIMES = ["08:00", "10:00"];

function Onboarding() {
  const { data: profile } = useProfile();
  const { data: prefs } = usePrefs();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [tz, setTz] = useState("Asia/Kolkata");
  const [cats, setCats] = useState<string[]>([]);
  const [count, setCount] = useState(20);
  const [about, setAbout] = useState(EXAMPLE);
  const [times, setTimes] = useState<string[]>(DEFAULT_TIMES);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Seed from the rows handle_new_user created, but still render if either is missing —
    // gating on both meant a user with no profile row sat on the spinner with no way out.
    if (ready || (!profile && !prefs)) return;
    setName(profile?.full_name ?? "");
    setTz(browserTimezone());
    setAbout(profile?.news_profile ?? EXAMPLE);
    setCats(prefs?.categories ?? CATEGORIES.slice(0, 4));
    setCount(prefs?.headline_count ?? 20);
    setTimes(prefs?.email_times?.length ? prefs.email_times : DEFAULT_TIMES);
    setReady(true);
  }, [profile, prefs, ready]);

  async function finish() {
    setSaving(true);
    try {
      const { data } = await supabase.auth.getUser();
      const id = data.user!.id;
      const p = await supabase
        .from("profiles")
        .update({
          full_name: name.trim() || null,
          timezone: tz,
          news_profile: about.trim() || null,
          onboarded_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("id");
      if (p.error) throw p.error;
      // An update that matched nothing leaves onboarded_at null, and the route guard would
      // bounce the user straight back here — say so instead of looping silently.
      if (!p.data?.length)
        throw new Error("Your profile could not be found. Please sign out and in again.");
      const n = await supabase.from("news_prefs").upsert({
        user_id: id,
        categories: cats,
        headline_count: count,
        email_times: [...times].sort(),
      });
      if (n.error) throw n.error;
      await qc.invalidateQueries({ queryKey: qk.profile });
      await qc.invalidateQueries({ queryKey: qk.prefs });
      navigate({ to: "/brief", replace: true });
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  }

  const canNext = step === 0 ? name.trim().length > 0 : step === 1 ? cats.length > 0 : true;

  return (
    <div className="flex min-h-dvh flex-col items-center bg-background bg-hero px-4 py-10">
      <Logo className="mb-8" />
      <div className="mb-6 flex w-full max-w-lg items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex-1">
            <div
              className={cn(
                "h-1 rounded-full transition-calm",
                i <= step ? "bg-primary" : "bg-muted",
              )}
            />
            <p className={cn("mt-2 text-xs", i === step ? "font-medium" : "text-muted-foreground")}>
              {s}
            </p>
          </div>
        ))}
      </div>
      <Card className="w-full max-w-lg p-6 md:p-8">
        {!ready ? (
          <div className="flex justify-center py-10">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : step === 0 ? (
          <div className="space-y-5">
            <div>
              <h1 className="text-xl font-semibold">Welcome. What should we call you?</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Dates and email times use your timezone.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 rounded-xl"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>Timezone</Label>
              <TimezoneSelect value={tz} onChange={setTz} />
            </div>
          </div>
        ) : step === 1 ? (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-semibold">What news matters to you?</h1>
              <p className="mt-1 text-sm text-muted-foreground">Pick at least one topic.</p>
            </div>
            <CategoryPicker value={cats} onChange={setCats} />
            <div className="space-y-2">
              <Label>Headlines per day</Label>
              <div>
                <Segmented options={[10, 20, 30]} value={count} onChange={setCount} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="about">About you</Label>
              <Textarea
                id="about"
                rows={3}
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                className="rounded-xl"
              />
              <p className="text-xs text-muted-foreground">Helps AI rank stories for you.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <h1 className="text-xl font-semibold">When should your brief arrive?</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                We'll email your tasks and top stories at these times.
              </p>
            </div>
            <EmailTimes value={times} onChange={setTimes} tz={tz} />
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <Button
            variant="ghost"
            className="h-11 rounded-xl"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            <ArrowLeft /> Back
          </Button>
          {step < 2 ? (
            <Button
              className="h-11 rounded-xl"
              disabled={!canNext}
              onClick={() => setStep(step + 1)}
            >
              Continue <ArrowRight />
            </Button>
          ) : (
            <Button className="h-11 rounded-xl" disabled={saving} onClick={finish}>
              {saving && <Loader2 className="animate-spin" />} Finish
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
