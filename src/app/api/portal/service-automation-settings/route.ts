import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertAutomationSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import {
  loadServiceAutomationSettings,
  saveServiceAutomationSettings,
} from "@/lib/service-automation-settings.server";
import { normalizeServiceAutomationSettings, type ServiceAutomationSettings } from "@/lib/service-automation-settings";
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

const NAMESPACE = "serviceAutomation" as const;
const ANALYTICS_MODULE = "service_automation";

/**
 * Settings → Services knobs that are actions rather than reminders (PLAN-0915):
 * response promise, offer expiry, on-my-way, resident confirmation, ratings.
 *
 * `serviceAutomation` was declared in `OperationsNamespace` but never wired to
 * a route — this is that wiring, plus the new workspace rung (PLAN-0920-0845).
 * `?propertyId=` / `?workspaceId=` resolve property override → workspace row
 * → account row.
 */
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
  if (!(roleList.includes("manager") || legacy === "manager" || legacy === "admin")) return null;
  return { db, userId: user.id };
}

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

async function loadCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ settings: ServiceAutomationSettings; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeServiceAutomationSettings, loadAccount: (d, m) => loadServiceAutomationSettings(d, m) },
  );
  return { settings: value, source };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { propertyId: bodyPropertyId, workspaceId: bodyWorkspaceId, reset, ...rest } = body;
    const scope = resolveSettingsScopeParams(req.url, { propertyId: bodyPropertyId, workspaceId: bodyWorkspaceId });
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    if (reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: propertyId ? "property" : "workspace", inherited: true, overriddenPropertyIds, source });
    }

    const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
    const normalized = normalizeServiceAutomationSettings({ ...current, ...rest });
    const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
    if (propertyId) {
      await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, normalized);
    } else if (workspaceId) {
      await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, normalized);
    } else {
      await saveServiceAutomationSettings(ctx.db, ownerUserId, normalized);
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
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
