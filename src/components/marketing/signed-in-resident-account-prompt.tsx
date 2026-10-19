"use client";

import { AddResidentRoleButton } from "@/components/marketing/add-resident-role-button";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

export type SignedInResidentPromptPurpose = "apply" | "lease" | "tour";

const HEADING: Record<SignedInResidentPromptPurpose, string> = {
  apply: "Create your resident account to apply",
  lease: "Create your resident account to sign your lease",
  tour: "Create your resident account to schedule your tour",
};

const NEED: Record<SignedInResidentPromptPurpose, (listing: string) => string> = {
  apply: (listing) => `To rent ${listing}`,
  lease: (listing) => `To sign your lease for ${listing}`,
  tour: (listing) => `To schedule your tour of ${listing}`,
};

/**
 * Shown on the PUBLIC apply surface when the visitor is signed in but does NOT
 * hold the resident role (a manager or vendor). A resident account is required
 * (PLAN-0924-1421) — adding the role is the only way forward.
 */
export function SignedInResidentAccountPrompt({
  applyReturnPath,
  propertyTitle,
  purpose = "apply",
  ps = false,
}: {
  applyReturnPath: string;
  propertyTitle?: string;
  purpose?: SignedInResidentPromptPurpose;
  /** Journey styling for the public `.ps` apply page; the resident portal keeps the default. */
  ps?: boolean;
}) {
  const autofill = useProspectContactAutofill();
  const listing = propertyTitle?.trim() || "this home";

  if (ps) {
    return (
      <div className="ps-j-gate">
        <p className="ps-j-eyebrow">You&apos;re signed in</p>
        <h2 className="ps-h3">{HEADING[purpose]}</h2>
        <p>
          {NEED[purpose](listing)}, add a separate resident account on your existing login — same email, no new
          password, and its own resident portal kept separate from your current account.
        </p>
        <div className="ps-j-btn-row">
          <AddResidentRoleButton
            returnPath={applyReturnPath}
            contactEmail={autofill.email || undefined}
            className="ps-btn ps-btn-blue !rounded-[3px] !bg-[var(--ps-blue)] lg:!h-11 lg:!px-[18px] lg:!text-[15px]"
            dataAttr="signed-in-create-resident-account"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">You&apos;re signed in</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">{HEADING[purpose]}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {NEED[purpose](listing)}, add a separate resident account on your existing login — same email, no new password,
        and its own resident portal kept separate from your current account.
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <AddResidentRoleButton
          returnPath={applyReturnPath}
          contactEmail={autofill.email || undefined}
          className="min-h-[44px] min-w-0 flex-1 rounded-full px-5 text-[15px] font-semibold sm:px-6"
          dataAttr="signed-in-create-resident-account"
        />
      </div>
    </div>
  );
}
