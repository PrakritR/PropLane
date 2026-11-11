import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { readPhoneSignInPreference } from "@/lib/auth/phone-sign-in-preference.server";
import CreateAccountRouter from "./create-account-router";

/** Avoid static prerender issues with search params / client hooks in production. */
export const dynamic = "force-dynamic";

function CreateAccountFallback() {
  return (
    <AuthCard variant="blend">
      <p className="text-center text-sm text-muted">Loading…</p>
    </AuthCard>
  );
}

export default async function CreateAccountPage() {
  // The resident path leads with "text me a code" only while phone sign-in is on; the server still decides at start.
  const phoneSignup = await readPhoneSignInPreference();
  return (
    <Suspense fallback={<CreateAccountFallback />}>
      <CreateAccountRouter phoneSignup={phoneSignup} />
    </Suspense>
  );
}
