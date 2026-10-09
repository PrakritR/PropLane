"use client";

import { AdminBillingActionDialog } from "@/components/portal/admin-billing-action-dialog";
import type { AdminActiveRequest } from "@/components/portal/use-admin-account-actions";
import { ADMIN_ACCOUNT_ROLE_LABEL } from "@/lib/admin/admin-account-keys";

/**
 * The reason popup behind every Disable / Enable account control. Turning an account off or back on
 * is a decision about a person's access, so the reason is required and lands in the audit trail.
 */
export function AdminAccountActiveDialog({
  request,
  onClose,
  onSubmit,
}: {
  request: AdminActiveRequest | null;
  onClose: () => void;
  onSubmit: (request: AdminActiveRequest, reason: string) => Promise<string | null>;
}) {
  const label = request ? `${request.active ? "Enable" : "Disable"} ${ADMIN_ACCOUNT_ROLE_LABEL[request.kind].toLowerCase()} account` : "";
  return (
    <AdminBillingActionDialog
      open={request !== null}
      title={label}
      submitLabel={label}
      dataAttr="admin-account-active-dialog"
      onClose={onClose}
      onSubmit={(reason) => (request ? onSubmit(request, reason) : Promise.resolve(null))}
    />
  );
}
