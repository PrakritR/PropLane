import "server-only";

import { readViewAsSecret, verifyViewAsToken } from "@/lib/auth/view-as-token";
import { readViewAsCookieValue, recordViewAsEnded } from "@/lib/auth/view-as.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Sign-out while a "View as" session is open: write the session's ended row
 * (best effort, never blocks sign-out). `realUserId` is the signed-in operator,
 * from the real-identity read the sign-out route does; a cookie that names a
 * different operator is ignored (and cleared by the route).
 */
export async function closeViewAsSessionOnSignOut(realUserId: string | undefined): Promise<void> {
  if (!realUserId) return;
  try {
    const payload = await verifyViewAsToken(await readViewAsCookieValue(), readViewAsSecret(), { allowExpired: true });
    if (!payload || payload.adminId !== realUserId) return;
    const expired = Math.floor(Date.now() / 1000) >= payload.exp;
    await recordViewAsEnded(createSupabaseServiceRoleClient(), payload, expired ? "expired" : "ended");
  } catch {
    /* sign-out must always proceed */
  }
}
