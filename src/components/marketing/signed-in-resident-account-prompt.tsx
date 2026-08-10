"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AddResidentRoleButton } from "@/components/marketing/add-resident-role-button";
import { markPublicApplyGuestContinue } from "@/lib/rental-application/public-apply-session";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

/**
 * Shown on the PUBLIC apply surface when the visitor is signed in but does NOT
 * hold the resident role (a manager or vendor).
 */
export function SignedInResidentAccountPrompt({
  gateKey,
  applyReturnPath,
  propertyTitle,
  onContinueGuest,
}: {
  gateKey: string;
  applyReturnPath: string;
  propertyTitle?: string;
  onContinueGuest: () => void;
}) {
  const autofill = useProspectContactAutofill();
  const listing = propertyTitle?.trim() || "this home";
  const createHref = residentCreateAccountHref(applyReturnPath, {
    email: autofill.email || undefined,
    fullName: autofill.name || undefined,
    phone: autofill.phone || undefined,
  });

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">You&apos;re signed in</p>
      <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">
        Create your resident account to apply
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        To rent {listing}, add a separate resident account on your existing login — same email, no new password, and
        its own resident portal kept separate from your current account.
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <AddResidentRoleButton
          returnPath={applyReturnPath}
          className="min-h-[44px] min-w-0 flex-1 rounded-full px-5 text-[15px] font-semibold sm:px-6"
          dataAttr="signed-in-create-resident-account"
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px] min-w-0 flex-1 rounded-full px-5 text-[15px] font-semibold sm:px-6"
          data-attr="signed-in-apply-as-guest"
          onClick={() => {
            markPublicApplyGuestContinue(gateKey);
            onContinueGuest();
          }}
        >
          Apply as a guest instead
        </Button>
      </div>
    </div>
  );
}
