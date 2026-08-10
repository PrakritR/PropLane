"use client";

import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ensureSignedInResidentPortal } from "@/lib/tour-resident-link.client";
import { safeNextPath } from "@/lib/auth/safe-next-path";

/**
 * "Create resident account" for a visitor who is ALREADY SIGNED IN.
 *
 * These gates promise exactly what /auth/get-started → "I'm applying to rent"
 * does: "add a separate resident account on your existing login — same email, no
 * new password". They were `<Link>`s to the create-account FORM, which asks a
 * signed-in user to make a second account from scratch — contradicting their own
 * copy and dead-ending anyone who tries, since the email is already taken.
 *
 * Goes through `ensureSignedInResidentPortal`, the existing client helper for
 * exactly this action, rather than the generic role-chooser provisioning call:
 * the generic one POSTs an empty body, so `redirectTo`, `contactEmail` and
 * `phone` never reach `/api/auth/create-resident-account` and the prospect's
 * phone is never stored on the profile — the value that backs outbound
 * Communication identity.
 */
export function AddResidentRoleButton({
  returnPath,
  contactEmail,
  phone,
  className,
  dataAttr,
  label = "Create resident account",
}: {
  returnPath: string;
  contactEmail?: string;
  phone?: string;
  className?: string;
  dataAttr?: string;
  label?: string;
}) {
  const { showToast } = useAppUi();

  // No local busy state: the shared Button already tracks a promise returned
  // from onClick (spinner, aria-busy, disabled, and an in-flight ref that blocks
  // a second click). A local `finally { setBusy(false) }` would also clear the
  // moment the promise settles — while the navigation below is still in flight —
  // re-enabling the button and allowing a second account-creation POST.
  const run = async () => {
    const target = safeNextPath(returnPath) ?? "/resident/dashboard";
    const result = await ensureSignedInResidentPortal(target, { contactEmail, phone });
    if (!result.ok) {
      showToast(result.error ?? "Could not add a resident account. Please try again.");
      return;
    }
    // Full navigation, not a client push: the session's roles just changed and
    // the portal guards read them server-side. Deliberately no state reset after
    // this line — the page is going away.
    window.location.assign(result.redirectTo);
  };

  return (
    <Button
      type="button"
      variant="primary"
      className={className}
      data-attr={dataAttr}
      onClick={() => run()}
    >
      {label}
    </Button>
  );
}
