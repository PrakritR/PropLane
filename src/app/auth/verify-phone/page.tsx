import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { PhoneAuthForm } from "@/components/auth/phone-auth-form";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export default async function VerifyPhonePage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next = "" } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=${encodeURIComponent(next || "/auth/continue")}`);
  const config = await loadSharedLineConfig(createSupabaseServiceRoleClient());
  if (config.mode !== "shared") redirect(oauthContinuePath(next));

  return (
    <div className="mx-auto w-full max-w-[460px] self-center">
      <AuthCard variant="blend">
        <h1 className="mb-6 text-center text-[1.75rem] font-bold tracking-tight text-foreground">Verify your phone</h1>
        <PhoneAuthForm mode="verify_phone" nextPath={next} />
      </AuthCard>
    </div>
  );
}
