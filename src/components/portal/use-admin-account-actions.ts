"use client";

import { useCallback, useState } from "react";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import {
  ADMIN_ACCOUNT_API_PATH,
  ADMIN_ACCOUNT_ROLE_LABEL,
  type AdminAccountRowKind,
} from "@/lib/admin/admin-account-keys";

const DELETE_QUESTION: Record<AdminAccountRowKind, string> = {
  manager: "Permanently delete this manager, all properties, residents, payments, and login?",
  resident: "Permanently delete this resident, leases, payments, and login?",
  vendor: "Delete this vendor, their bids, invoices, and payouts?",
};

export type AdminActiveRequest = { kind: AdminAccountRowKind; id: string; active: boolean };

/**
 * Disable / enable and delete for one admin account, through the existing
 * per-kind admin routes (`/api/admin/managers|residents|vendors`). The row ⋯
 * on the Accounts list and the record page's header icons share this, so
 * both ask the same question before the one action that cannot be undone.
 */
export function useAdminAccountActions(onChanged: () => void) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  /** The enable / disable the reason popup is open for, or null. */
  const [activeRequest, setActiveRequest] = useState<AdminActiveRequest | null>(null);
  const askActive = useCallback(
    (kind: AdminAccountRowKind, id: string, active: boolean) => setActiveRequest({ kind, id, active }),
    [],
  );
  const clearActiveRequest = useCallback(() => setActiveRequest(null), []);

  /** Enable / disable with the staff member's reason (audited). Returns an error sentence, or null once it landed. */
  const setActive = useCallback(
    async (kind: AdminAccountRowKind, id: string, active: boolean, reason: string): Promise<string | null> => {
      setBusy(true);
      try {
        const res = await fetch(ADMIN_ACCOUNT_API_PATH[kind], {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, active, reason }),
        });
        if (!res.ok) {
          const { error } = (await res.json().catch(() => ({}))) as { error?: string };
          return error || "Could not update account.";
        }
        showToast(`${ADMIN_ACCOUNT_ROLE_LABEL[kind]} account ${active ? "enabled" : "disabled"}.`);
        onChanged();
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onChanged, showToast],
  );

  const remove = useCallback(
    async (kind: AdminAccountRowKind, id: string, name: string) => {
      const ok = await confirm({
        title: "Delete account",
        description: `${name ? `${name}: ` : ""}${DELETE_QUESTION[kind]}`,
        confirmLabel: "Delete account",
      });
      if (!ok) return false;
      setBusy(true);
      try {
        const res = await fetch(ADMIN_ACCOUNT_API_PATH[kind], {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          const { error } = (await res.json().catch(() => ({}))) as { error?: string };
          showToast(error || "Could not delete account.");
          return false;
        }
        showToast(`${ADMIN_ACCOUNT_ROLE_LABEL[kind]} account deleted.`);
        onChanged();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [confirm, onChanged, showToast],
  );

  return { busy, setActive, askActive, activeRequest, clearActiveRequest, remove };
}
