import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { profileQuery } from "@/lib/queries";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/login" });
    const profile = await context.queryClient.ensureQueryData(profileQuery());
    const onboarding = location.pathname.startsWith("/onboarding");
    if (!profile?.onboarded_at && !onboarding) throw redirect({ to: "/onboarding" });
    if (profile?.onboarded_at && onboarding) throw redirect({ to: "/brief" });
  },
  component: () => <Outlet />,
});
