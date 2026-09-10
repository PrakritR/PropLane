import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { schedulePortalAccountDeletion } from "@/lib/auth/account-recovery.server";
import { shouldUseLegacyPortalAccountDeletion } from "@/lib/auth/account-recovery-schema";
import {
  deleteOwnPortalAccount,
  type DeleteOwnPortalAccountResult,
  type SelfDeletePortal,
} from "@/lib/auth/delete-portal-account";

export type PortalSelfDeleteResult = DeleteOwnPortalAccountResult & {
  recoverUntil?: string;
  retentionDays?: number;
};

/**
 * Self-delete for one portal. Uses the 30-day retention coordinator when its
 * schema is deployed; otherwise falls back to the immediate purge + role/auth
 * removal path so residents can still delete before migrations land.
 */
export async function resolvePortalSelfDelete(
  db: SupabaseClient,
  userId: string,
  portal: SelfDeletePortal,
): Promise<PortalSelfDeleteResult> {
  if (portal === "admin") {
    const result = await deleteOwnPortalAccount(db, userId, portal);
    return { ...result, retentionDays: 0 };
  }

  try {
    const scheduled = await schedulePortalAccountDeletion(db, userId, portal);
    return {
      ok: true,
      mode: scheduled.mode,
      signedOut: scheduled.signedOut,
      redirectTo: scheduled.redirectTo,
      recoverUntil: scheduled.recoverUntil,
      retentionDays: 30,
    };
  } catch (error) {
    if (!shouldUseLegacyPortalAccountDeletion(error)) throw error;
    const legacy = await deleteOwnPortalAccount(db, userId, portal);
    return { ...legacy, retentionDays: 0 };
  }
}
