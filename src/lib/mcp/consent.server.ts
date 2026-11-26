/**
 * What a signed-in person may connect to PropLane as, for the `/mcp/authorize` screen and the approve route.
 *
 * Two kinds of target, never mixed: a manager WORKSPACE (one per connection) and "As resident" (their own
 * residency). The list is derived here from the server's own membership reads, and the approve route re-derives
 * it and checks the posted choice against it: a value in the form is a name, never a grant.
 *
 * Workspaces are `listViewerWorkspaces` (what the portal switcher and `resolveAgentContext` read: owned,
 * co-managed and PropLane Service seats) plus the PropLane Service workspaces the SAME resolver the admin
 * service shell uses (`loadServiceStaffWorkspaces`) says the viewer staffs. A read that fails drops the
 * workspaces it cannot vouch for rather than guessing.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listViewerWorkspaces } from "@/lib/workspaces/active.server";
import { loadServiceStaffWorkspaces } from "@/lib/service/service-mode.server";
import { loadWorkspaces } from "@/lib/workspaces/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAgentContext } from "@/lib/tools/context";
import { resolveResidentAgentContext, resolveResidentAgentContextForUser } from "@/lib/tools/resident-context";

export const MCP_RESIDENT_TARGET = "resident";

export type McpConsentOption =
  | { value: string; kind: "workspace"; workspaceId: string; label: string; service: boolean }
  | { value: typeof MCP_RESIDENT_TARGET; kind: "resident"; label: string };

export type McpConsent = {
  userId: string;
  email: string;
  db: SupabaseClient;
  options: McpConsentOption[];
  defaultValue: string;
};

export type McpTarget =
  | { portal: "manager"; workspaceId: string; workspaceName: string }
  | { portal: "resident" };

const WORKSPACE_PREFIX = "ws:";

/** The manager-side options for one user. Empty when they hold no manager seat at all. */
export async function listManagerConnectOptions(db: SupabaseClient, userId: string): Promise<McpConsentOption[]> {
  const [viewer, staff] = await Promise.all([
    listViewerWorkspaces(db, userId),
    loadServiceStaffWorkspaces(db, userId).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] as Awaited<ReturnType<typeof loadServiceStaffWorkspaces>> }),
    ),
  ]);
  const staffIds = new Set(staff.rows.map((w) => w.id));
  const options: McpConsentOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, service: boolean) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push({
      value: `${WORKSPACE_PREFIX}${id}`,
      kind: "workspace",
      workspaceId: id,
      label: service ? `${name.trim() || "Workspace"} (PropLane Service)` : name.trim() || "Your workspace",
      service,
    });
  };
  for (const w of viewer) {
    const service = (w as { isService?: boolean }).isService === true || staffIds.has(w.id);
    // A PropLane Service workspace the viewer owns is staff by the owner arm; one they merely sit on is staff only
    // if the staff resolver says so. If that read failed, a service workspace is not offered rather than guessed.
    if (service && !w.owned && !staffIds.has(w.id) && !staff.ok) continue;
    push(w.id, w.name, service);
  }
  // A staffed workspace the viewer list did not carry (it cannot be connected unless it also resolves strictly).
  if (staff.rows.length) {
    const all = await loadWorkspaces(db, userId).catch(() => []);
    for (const w of staff.rows) if (all.some((x) => x.id === w.id)) push(w.id, w.name, true);
  }
  return options;
}

/** Everything the consent screen shows for the signed-in browser session, or null when signed out / no door. */
export async function loadMcpConsent(): Promise<McpConsent | null> {
  const auth = await createSupabaseServerClient();
  const { data } = await auth.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const [manager, resident] = await Promise.all([
    resolveAgentContext().catch(() => null),
    resolveResidentAgentContext().catch(() => null),
  ]);
  const options: McpConsentOption[] = manager ? await listManagerConnectOptions(db, user.id).catch(() => []) : [];
  if (resident) options.push({ value: MCP_RESIDENT_TARGET, kind: "resident", label: "As resident" });
  if (options.length === 0) return null;
  const activeWorkspaceId = manager?.workspace?.id?.trim() ?? "";
  const preferred = options.find((o) => o.kind === "workspace" && o.workspaceId === activeWorkspaceId);
  return {
    userId: user.id,
    email: (manager?.email || resident?.email || user.email || "").trim().toLowerCase(),
    db,
    options,
    defaultValue: (preferred ?? options[0]).value,
  };
}

/**
 * Re-derive a posted choice. Null when it is not something this user may connect as right now (a removed seat, a
 * lapsed resident role, a made-up id).
 */
export async function resolveMcpTarget(db: SupabaseClient, userId: string, posted: string): Promise<McpTarget | null> {
  const value = posted.trim();
  if (value === MCP_RESIDENT_TARGET) {
    return (await resolveResidentAgentContextForUser(userId).catch(() => null)) ? { portal: "resident" } : null;
  }
  if (!value.startsWith(WORKSPACE_PREFIX)) return null;
  const options = await listManagerConnectOptions(db, userId).catch(() => []);
  const picked = options.find((o) => o.value === value);
  return picked && picked.kind === "workspace"
    ? { portal: "manager", workspaceId: picked.workspaceId, workspaceName: picked.label }
    : null;
}
