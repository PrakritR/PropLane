import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
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

export default function CreateAccountPage() {
  return (
    <Suspense fallback={<CreateAccountFallback />}>
      <CreateAccountRouter />
    </Suspense>
  );
}
