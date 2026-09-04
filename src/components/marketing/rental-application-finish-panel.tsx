"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CosignerInviteCallout } from "@/components/marketing/cosigner-invite-callout";
import { GroupInviteCallout } from "@/components/marketing/group-invite-callout";
import type { GroupRole } from "@/lib/rental-application/types";

type FinishPanelProps = {
  axisId: string;
  email: string;
  emailSent?: boolean;
  syncError?: string;
  /** Guest apply — offer inline account creation instead of email-only instructions. */
  guestFlow?: boolean;
  /** Signed-in resident portal apply — already has an account. */
  portalFlow?: boolean;
  /** Mailto fallback when Resend is not configured (local/dev). */
  mailtoHref?: string;
  /** Same-session handoff to resident account setup (guest flow). */
  setupHref?: string;
  /** Organizer application id for sharing a group invite link after submit. */
  groupLeaderAppId?: string;
  groupRole?: GroupRole;
  groupSize?: string;
  groupPropertyId?: string;
  hasCosigner?: "yes" | "no" | null;
  onDone: () => void;
};

/**
 * Group-application confirmation: the organizer shares an invite link; joiners see
 * they linked in. Rendered on the finish screen and on the resident's submitted application.
 */
export function GroupShareCallout({
  leaderAppId,
  groupRole,
  groupSize,
  propertyId,
  className,
  shareable = true,
}: {
  leaderAppId?: string;
  groupRole?: GroupRole;
  groupSize?: string;
  propertyId?: string;
  className?: string;
  shareable?: boolean;
}) {
  if (groupRole === "joining") {
    return (
      <div className={`mt-6 text-left ${className ?? ""}`}>
        <p className="text-[13px] font-semibold text-foreground">You joined a group application</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted sm:text-sm">
          Your application is linked to your group. Each member applies with their own account, and your manager reviews
          you together.
        </p>
      </div>
    );
  }

  if (!shareable) {
    return (
      <div className={`mt-6 text-left ${className ?? ""}`}>
        <p className="text-[13px] font-semibold text-foreground">Group application</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted sm:text-sm">
          Your application was not approved. Your group link is kept here for reference.
        </p>
        <p className="mt-2 font-mono text-xs text-muted">Application ID: {leaderAppId}</p>
      </div>
    );
  }

  if (!leaderAppId?.trim()) {
    return null;
  }

  return (
    <GroupInviteCallout
      leaderAppId={leaderAppId}
      groupSize={groupSize}
      propertyId={propertyId}
      className={`mt-6 ${className ?? ""}`}
    />
  );
}

export function RentalApplicationFinishPanel({
  axisId,
  email,
  emailSent,
  syncError,
  guestFlow = false,
  portalFlow = false,
  mailtoHref,
  setupHref,
  groupLeaderAppId,
  groupRole,
  groupSize,
  groupPropertyId,
  hasCosigner,
  onDone,
}: FinishPanelProps) {
  const signInHref = `/auth/sign-in?intent=resident&next=${encodeURIComponent("/resident/applications")}`;
  const applicationsHref = "/resident/applications";
  const emailFailed = guestFlow && emailSent === false;
  const showGroup = Boolean(groupLeaderAppId?.trim() && groupRole === "first");
  const showGroupJoined = groupRole === "joining";
  const showCosignerInvite = hasCosigner === "yes";
  const canCreateAccount = guestFlow && Boolean(setupHref?.startsWith("/auth/resident-setup"));

  return (
    <div className="application-finish-panel mx-auto mt-8 max-w-lg text-center sm:mt-12">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Done</p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Application submitted</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">
        {portalFlow
          ? email && emailSent
            ? `Thanks for submitting your application. We'll review it and get back to you. A confirmation was sent to ${email}.`
            : "Thanks for submitting your application. We'll review it and get back to you."
          : guestFlow
            ? canCreateAccount
              ? "Thanks for submitting your application. We'll review it and get back to you. Create your resident portal account now to track status."
              : emailFailed
                ? "Thanks for submitting your application. We saved it, but we could not send the setup email automatically."
                : email
                  ? `Thanks for submitting your application. We'll review it and get back to you. Check ${email} for your resident account setup link.`
                  : "Thanks for submitting your application. We'll review it and get back to you. Check your email for your resident account setup link."
            : email
              ? emailSent
                ? `We emailed a confirmation to ${email}. Sign in to track your application in the resident portal.`
                : `Confirmation for ${email}`
              : "Sign in to track your application in the resident portal."}
      </p>

      {syncError ? (
        <p className="mt-3 text-[12px] text-amber-800 sm:text-sm">
          Sync issue: {guestFlow ? "try submitting again, or sign in if you already have an account." : "sign in to confirm your application status."}
        </p>
      ) : null}

      <p className="mt-4 font-mono text-xs text-muted">Application ID: {axisId}</p>

      {showGroup ? (
        <GroupShareCallout
          leaderAppId={groupLeaderAppId!.trim()}
          groupRole={groupRole}
          groupSize={groupSize}
          propertyId={groupPropertyId}
        />
      ) : showGroupJoined ? (
        <GroupShareCallout groupRole="joining" />
      ) : null}

      {showCosignerInvite ? (
        <CosignerInviteCallout signerAppId={axisId} className="mt-6" />
      ) : null}

      <div className="mt-6 space-y-2.5 sm:mt-8 sm:space-y-3">
        {guestFlow ? (
          <>
            {canCreateAccount ? (
              <Link
                href={setupHref!}
                className="btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold sm:min-h-[48px] sm:text-base"
              >
                Create your resident account
              </Link>
            ) : null}
            {emailFailed ? (
              <p className="text-[12px] text-amber-800 sm:text-sm">
                Email delivery is not configured on this environment. Use the button below to open a draft with your setup link, or ask your manager to resend the welcome email.
              </p>
            ) : null}
            {mailtoHref ? (
              <a
                href={mailtoHref}
                className="btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold sm:min-h-[48px] sm:text-base"
              >
                Open setup email draft
              </a>
            ) : null}
            {canCreateAccount && email && emailSent ? (
              <p className="application-finish-detail text-[12px] text-muted sm:text-sm">
                We also emailed a backup setup link to {email}.
              </p>
            ) : null}
            <Link
              href={signInHref}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-border px-6 text-[15px] font-semibold text-foreground sm:min-h-[48px] sm:text-base"
            >
              Already have an account? Sign in
            </Link>
          </>
        ) : portalFlow ? (
          <Link
            href={applicationsHref}
            className="btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold sm:min-h-[48px] sm:text-base"
            onClick={onDone}
          >
            View my applications
          </Link>
        ) : (
          <Link
            href={signInHref}
            className="btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold sm:min-h-[48px] sm:text-base"
          >
            Sign in to resident portal
          </Link>
        )}
      </div>

      <div className="mt-4 flex justify-center sm:mt-6">
        </div>
    </div>
  );
}
