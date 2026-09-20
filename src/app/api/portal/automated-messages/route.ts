import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertAutomationSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import { loadAutomatedMessageSettings, saveAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { automatedMessageDefaults } from "@/lib/automated-messages-defaults.server";
import {
  normalizeAutomatedMessageSettings,
  type AutomatedMessageSettings,
} from "@/lib/automated-messages-settings";
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

const NAMESPACE = "automatedMessages" as const;
const ANALYTICS_MODULE = "automated_messages";

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

function legacyScope(source: SettingsResolutionSource): "property" | "workspace" {
  return source === "property" ? "property" : "workspace";
}

/** "Messages sent automatically" — per-event switch and template (PLAN-0915). */
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

async function loadCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ settings: AutomatedMessageSettings; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeAutomatedMessageSettings, loadAccount: (d, m) => loadAutomatedMessageSettings(d, m) },
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
      scope: legacyScope(source),
      inherited: Boolean(propertyId) && source !== "property",
      overriddenPropertyIds,
      source,
      defaults: automatedMessageDefaults(),
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
    const body = (await req.json().catch(() => ({}))) as {
      settings?: unknown;
      propertyId?: unknown;
      workspaceId?: unknown;
      reset?: unknown;
    };
    const scope = resolveSettingsScopeParams(req.url, body);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    // No property or workspace → the account store (its own per-key merge).
    if (!propertyId && !workspaceId) {
      const settings = await saveAutomatedMessageSettings(ctx.db, ownerUserId, body.settings ?? body);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "account", ownerUserId, workspaceId: null });
      return NextResponse.json({ settings, scope: "workspace", inherited: false, overriddenPropertyIds, source: "account" });
    }

    // Reset — clear the whole house override.
    if (body.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: legacyScope(source), inherited: true, overriddenPropertyIds, source });
    }

    // Workspace patch — merge onto the CURRENT effective settings, store on the workspace row.
    if (!propertyId && workspaceId) {
      const { settings: current } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const incoming = normalizeAutomatedMessageSettings(body.settings ?? body);
      const merged: AutomatedMessageSettings = { ...current, ...incoming };
      await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, merged);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "workspace", ownerUserId, workspaceId });
      return NextResponse.json({ settings: merged, scope: "workspace", inherited: false, overriddenPropertyIds, source: "workspace" });
    }

    // House patch — merge onto the CURRENT effective settings (override or
    // workspace/account), then store the whole blob as this house's override.
    const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
    const incoming = normalizeAutomatedMessageSettings(body.settings ?? body);
    const merged: AutomatedMessageSettings = { ...current, ...incoming };
    await savePropertyOverride(ctx.db, ownerUserId, propertyId as string, NAMESPACE, merged);
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "property", ownerUserId, workspaceId });
    return NextResponse.json({ settings: merged, scope: "property", inherited: false, overriddenPropertyIds, source: "property" });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
