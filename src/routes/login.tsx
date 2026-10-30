import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, Logo } from "@/components/common";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Daily Edge" },
      {
        name: "description",
        content: "Sign in to Daily Edge with a code sent to your email.",
      },
      { property: "og:title", content: "Sign in — Daily Edge" },
      {
        property: "og:description",
        content: "Sign in to Daily Edge with a code sent to your email.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Login,
});

/**
 * Sign-in is a code typed back into this page, not a clicked link. No redirect URL is
 * involved, so this works the same whether the request came from the web app, a device
 * with no browser of its own (Alexa linking), or an email opened on a different device
 * entirely.
 */
function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/brief", replace: true });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) navigate({ to: "/brief", replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setLoading(false);
    if (error) toast.error(error.message);
    // A successful verify lands a session, which the onAuthStateChange listener above
    // picks up and navigates away from — nothing else to do here.
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background bg-hero px-4">
      <Link to="/" className="mb-8">
        <Logo />
      </Link>
      <Card className="w-full max-w-sm p-6 md:p-8">
        {sent ? (
          <form onSubmit={verifyCode} className="space-y-5">
            <div>
              <h1 className="text-xl font-semibold">Enter your code</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a 6-digit code to{" "}
                <span className="font-medium text-foreground">{email}</span>.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="h-11 rounded-xl text-center text-lg tracking-[0.3em]"
              />
            </div>
            <Button
              type="submit"
              className="h-11 w-full rounded-xl"
              disabled={loading || code.trim().length < 6}
            >
              {loading && <Loader2 className="animate-spin" />} Verify and sign in
            </Button>
            <Button
              variant="ghost"
              type="button"
              className="w-full rounded-xl"
              onClick={() => {
                setSent(false);
                setCode("");
              }}
            >
              <ArrowLeft /> Use a different email
            </Button>
          </form>
        ) : (
          <form onSubmit={sendCode} className="space-y-5">
            <div>
              <h1 className="text-xl font-semibold">Sign in or sign up</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                We'll email you a 6-digit code — no password needed.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoFocus
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 rounded-xl"
              />
            </div>
            <Button type="submit" className="h-11 w-full rounded-xl" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <KeyRound />} Send code
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
