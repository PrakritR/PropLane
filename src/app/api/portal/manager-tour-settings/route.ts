import { NextResponse } from "next/server";
import { loadManagerTourSettings, saveManagerTourSettings, normalizeManagerTourSettings, type ManagerTourSettings } from "@/lib/manager-tour-settings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTourSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";
import {
  resolveSettingsScope,
  saveWorkspaceNamespaceSettings,
  type SettingsResolutionSource,
} from "@/lib/settings/scope-resolver.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
  trackSettingsScopeChanged,
  writeRungFromSource,
} from "@/lib/scope/settings-scope";

export const runtime = "nodejs";

const NAMESPACE = "tourSettings" as const;
const ANALYTICS_MODULE = "tour_settings";

/**
 * `tourSettings` had no property scoping at all before PLAN-0920-0845 — every
 * manager had exactly one, portfolio-wide, tour notice window. This route now
 * resolves property override → workspace row → account row, same shape as
 * every other settings route.
 */
function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager =
    roleList.includes("manager") ||
    roleList.includes("owner") ||
    roleList.includes("pro") ||
    legacy === "manager" ||
    legacy === "admin" ||
    legacy === "owner" ||
    legacy === "pro";
  if (!isManager) return null;
  return { db, userId: user.id };
}

async function loadCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ settings: ManagerTourSettings; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeManagerTourSettings, loadAccount: (d, m) => loadManagerTourSettings(d, m) },
  );
  return { settings: value, source };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertTourSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;
    const [{ settings, source }, overriddenPropertyIds] = await Promise.all([
      loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({
      settings,
      scope: propertyId ? "property" : "workspace",
      inherited: Boolean(propertyId) && source !== "property",
      overriddenPropertyIds,
      source,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertTourSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json().catch(() => null)) as
      | { tourNoticeDays?: unknown; propertyId?: unknown; workspaceId?: unknown; reset?: unknown }
      | null;
    const scope = resolveSettingsScopeParams(req.url, body ?? undefined);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    if (body?.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: propertyId ? "property" : "workspace", inherited: true, overriddenPropertyIds, source });
    }

    const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
    const patch: Record<string, unknown> = { ...(body ?? {}) };
    delete patch.propertyId;
    delete patch.workspaceId;
    delete patch.reset;
    const normalized = normalizeManagerTourSettings({ ...current, ...patch });
    const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
    if (propertyId) {
      await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, normalized);
    } else if (workspaceId) {
      await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, normalized);
    } else {
      await saveManagerTourSettings(ctx.db, ownerUserId, normalized);
    }
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung, ownerUserId, workspaceId });
    return NextResponse.json({
      settings: normalized,
      scope: propertyId ? "property" : "workspace",
      inherited: false,
      overriddenPropertyIds,
      source: rung,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
