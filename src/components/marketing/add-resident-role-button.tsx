"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { provisionPortalFromGetStarted } from "@/lib/auth/provision-portal-from-get-started";
import { safeNextPath } from "@/lib/auth/safe-next-path";

/**
 * "Create resident account" for a visitor who is ALREADY SIGNED IN.
 *
 * These gates promise exactly what /auth/get-started → "I'm applying to rent"
 * does: "add a separate resident account on your existing login — same email, no
 * new password". They were `<Link>`s to the create-account FORM, which asks a
 * signed-in user to make a second account from scratch — contradicting their own
 * copy and dead-ending anyone who tries (the email is already taken).
 *
 * This adds the resident role to the current login through the same
 * provisioning path the role chooser uses, then continues to wherever the
 * visitor was headed.
 */
export function AddResidentRoleButton({
  returnPath,
  className,
  dataAttr,
  label = "Create resident account",
}: {
  returnPath: string;
  className?: string;
  dataAttr?: string;
  label?: string;
}) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await provisionPortalFromGetStarted("resident");
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      const destination = safeNextPath(returnPath) ?? result.redirectTo;
      // Full navigation, not a client push: the session's roles just changed and
      // the portal guards read them server-side.
      window.location.assign(destination);
    } catch {
      showToast("Could not add a resident account. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="primary"
      className={className}
      data-attr={dataAttr}
      disabled={busy}
      onClick={() => run()}
    >
      {busy ? "Setting up…" : label}
    </Button>
  );
}
