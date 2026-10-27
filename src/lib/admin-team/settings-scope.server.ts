import "server-only";
import { cookies } from "next/headers";
import { getPortalAccessContext, hasAdminRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadAdminServiceShell, resolvePortalServiceShell } from "@/lib/service/service-mode.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import type { SettingsScope } from "@/lib/admin-team/settings-scope";

/** Settings opened from /admin: PropLane scope, with every service workspace the admin can open in the dropdown. */
export async function loadAdminSettingsScope(userId: string): Promise<SettingsScope | null> {
  try {
    const shell = await loadAdminServiceShell(createSupabaseServiceRoleClient(), userId);
    return { overall: true, workspaces: shell.workspaces, currentWorkspaceId: null };
  } catch {
    return null;
  }
}

/**
 * Settings opened from /portal: the dropdown exists only in service mode (the active workspace is a PropLane Service
 * workspace this viewer is staff of); an ordinary manager's Settings has no scope to pick.
 */
export async function loadPortalSettingsScope(userId: string): Promise<SettingsScope | null> {
  try {
    const cookieId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
    const overall = hasAdminRole(await getPortalAccessContext());
    const result = await resolvePortalServiceShell(createSupabaseServiceRoleClient(), userId, cookieId, overall);
    if (result.mode !== "service") return null;
    return { overall, workspaces: result.shell.workspaces, currentWorkspaceId: result.shell.activeId };
  } catch {
    return null;
  }
}
