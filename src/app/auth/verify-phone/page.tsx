import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { PhoneAuthForm } from "@/components/auth/phone-auth-form";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { phoneAuthEnabled, phoneVerificationEnabled, readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export default async function VerifyPhonePage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext = "" } = await searchParams;
  // A destination is only ever a same-origin relative path, never an off-site URL.
  const next = safeNextPath(rawNext) ?? "";
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/sign-in?next=${encodeURIComponent(next || "/auth/continue")}`);
  const db = createSupabaseServiceRoleClient();
  // Shared line: the older gate. Otherwise this page exists only while phone_required is on, and an account that
  // already holds a verified phone has nothing to verify here (changing it lives in Settings).
  const shared = await phoneAuthEnabled(db);
  if (!shared) {
    if (!(await phoneVerificationEnabled(db))) redirect(oauthContinuePath(next));
    const identity = await readPhoneIdentity(db, user.id).catch(() => null);
    if (identity?.verified) redirect(oauthContinuePath(next));
  }

  return (
    <div className="mx-auto w-full max-w-[460px] self-center">
      <AuthCard variant="blend">
        <h1 className="mb-6 text-center text-[1.75rem] font-bold tracking-tight text-foreground">Verify your phone</h1>
        <PhoneAuthForm mode="verify_phone" nextPath={next} allowSkip={!shared} />
      </AuthCard>
    </div>
  );
}
