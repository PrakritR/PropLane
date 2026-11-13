import { NextResponse } from "next/server";
import { assertAutomationSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { assertSettingsScopeOwned, resolveSettingsScopeParams } from "@/lib/scope/settings-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadStayMessageSettings } from "@/lib/stay-messages/facts.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { STAY_SOURCES } from "@/lib/stay-messages/settings-defaults";
import { normalizeStayMessageSettings } from "@/lib/stay-messages/templates";

export const runtime = "nodejs";

/**
 * Settings -> Automations -> Check-in and check-out messages (design-1112 §7): per-source switches, the contact number each
 * source sees, and the two editable templates. Workspace-level, stored on `workspace_automation_settings.row_data.stayMessages`.
 */
async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;
  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return null;
  return { db, userId: user.id };
}

async function resolveWorkspace(ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; userId: string }, req: Request, intent: "read" | "edit") {
  const scope = resolveSettingsScopeParams(req.url);
  const access = await assertSettingsScopeOwned(ctx.db, ctx.userId, { workspaceId: scope.workspaceId ?? undefined, propertyId: undefined }, { intent });
  if (!access.ok) return { error: NextResponse.json({ error: access.error }, { status: access.status }) } as const;
  const workspaceId = access.workspaceId ?? (await userDefaultWorkspaceId(ctx.db, access.ownerUserId).catch(() => ""));
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace." }, { status: 400 }) } as const;
  return { workspaceId, ownerUserId: access.ownerUserId } as const;
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const resolved = await resolveWorkspace(ctx, req, "read");
    if ("error" in resolved) return resolved.error;
    return NextResponse.json({ settings: await loadStayMessageSettings(ctx.db, { workspaceId: resolved.workspaceId }) });
  } catch {
    return NextResponse.json({ error: "Could not load the settings." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const resolved = await resolveWorkspace(ctx, req, "edit");
    if ("error" in resolved) return resolved.error;
    const body = (await req.json().catch(() => ({}))) as { settings?: unknown };
    // A contact number is validated, never silently replaced: a bad one is refused so the manager sees it.
    const phones = (body.settings as { contactPhone?: Record<string, unknown> } | undefined)?.contactPhone;
    if (phones && typeof phones === "object") {
      for (const [source, value] of Object.entries(phones)) {
        if (!(STAY_SOURCES as readonly string[]).includes(source)) return NextResponse.json({ error: "Unknown source." }, { status: 400 });
        if (typeof value !== "string" || !normalizeE164(value)) return NextResponse.json({ error: "Enter a valid phone number, like +12065550100." }, { status: 400 });
      }
    }
    const current = await loadStayMessageSettings(ctx.db, { workspaceId: resolved.workspaceId });
    const next = normalizeStayMessageSettings({ ...current, ...(body.settings && typeof body.settings === "object" ? (body.settings as object) : {}) });
    const { data: existing } = await ctx.db.from("workspace_automation_settings").select("row_data").eq("workspace_id", resolved.workspaceId).maybeSingle();
    const rowData = { ...(((existing as { row_data?: unknown } | null)?.row_data as Record<string, unknown> | undefined) ?? {}), stayMessages: next };
    const { error } = await ctx.db
      .from("workspace_automation_settings")
      .upsert({ workspace_id: resolved.workspaceId, owner_user_id: resolved.ownerUserId, row_data: rowData, updated_at: new Date().toISOString() }, { onConflict: "workspace_id" });
    if (error) return NextResponse.json({ error: "Could not save the settings." }, { status: 500 });
    return NextResponse.json({ settings: next });
  } catch {
    return NextResponse.json({ error: "Could not save the settings." }, { status: 500 });
  }
}
