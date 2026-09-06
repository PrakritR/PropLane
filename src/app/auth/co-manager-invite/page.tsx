import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { CoManagerInviteClient } from "./co-manager-invite-client";

export default function CoManagerInvitePage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <p className="text-center text-sm text-muted">Loading invite…</p>
        </AuthCard>
      }
    >
      <CoManagerInviteClient />
    </Suspense>
  );
}
