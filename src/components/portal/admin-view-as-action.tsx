"use client";

import { AdminViewAsAction as AdminViewAsDialogAction } from "@/components/portal/admin-view-as-dialog";
import type { AdminAccountRowKind } from "@/lib/admin/admin-account-keys";

/**
 * The "View as" button for an account record.
 *
 * Rendered FIRST in the account record's header actions
 * (`admin-account-record-page.tsx`), before the Disable and Delete icons. The
 * mechanics (eligibility, dialog, signed session, banner) live in
 * `admin-view-as-dialog.tsx`; this only adapts the record's account shape.
 */
export type AdminViewAsAccount = {
  id: string;
  kind: AdminAccountRowKind;
  email: string;
  name: string;
  /** A disabled account cannot be viewed as. */
  active: boolean;
};

export function AdminViewAsAction({ account }: { account: AdminViewAsAccount }) {
  if (!account.active) return null;
  return (
    <AdminViewAsDialogAction
      targetUserId={account.id}
      targetName={account.name || account.email}
      preferredPortal={account.kind}
    />
  );
}
