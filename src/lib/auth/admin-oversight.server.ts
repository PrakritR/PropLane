import { ADMIN_OVERSIGHT_PARAM, ADMIN_OVERSIGHT_VALUE } from "@/lib/auth/admin-oversight-shared";
import { isAdminUser } from "@/lib/auth/admin-preview";

/**
 * Admin oversight is an explicit product surface, never an implicit privilege of the account.
 *
 * A platform admin who also manages a workspace uses the manager portal like any manager: they read
 * their own and granted houses, narrowed to the active workspace. Nothing from one workspace appears
 * in another. The all-owners read is served only when the request ASKS for it (`?oversight=admin`,
 * sent by admin pages through `adminOversightUrl`) AND the server confirms the admin role.
 */

/** True when the request asked for the all-owners (admin oversight) read. Says nothing about the role. */
export function wantsAdminOversight(req: Request): boolean {
  try {
    return new URL(req.url).searchParams.get(ADMIN_OVERSIGHT_PARAM) === ADMIN_OVERSIGHT_VALUE;
  } catch {
    return false;
  }
}

/**
 * The all-owners read is allowed for this request: it asked for oversight AND the caller is an admin.
 * Pass `admin` when the route already resolved the flag, to avoid a second lookup.
 */
export async function resolveAdminOversight(req: Request, userId: string, admin?: boolean): Promise<boolean> {
  if (!wantsAdminOversight(req)) return false;
  return admin ?? (await isAdminUser(userId));
}
