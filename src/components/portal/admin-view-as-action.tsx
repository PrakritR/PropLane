"use client";

import type { AdminAccountRowKind } from "@/lib/admin/admin-account-keys";

/**
 * SLOT: the "View as" button for an account record.
 *
 * Rendered FIRST in the account record's header actions
 * (`admin-account-record-page.tsx`), before the Disable and Delete icons. The
 * View-as mechanics (the preview route, the banner, the dialog) are owned by a
 * different change; this placeholder renders nothing and only fixes the name,
 * the position and the props that change will fill in.
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
  void account;
  return null;
}
