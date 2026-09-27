/**
 * Payment-reminder / tour-reminder / notification-routing settings
 * (`ManagerAutomationSettings`, the `paymentAutomation` namespace) plus
 * vendor dispatch.
 *
 * `paymentAutomation` was declared in `OperationsNamespace` but never wired to
 * a route — this is that wiring (PLAN-0920-0845). `?propertyId=` /
 * `?workspaceId=` resolve property override → workspace row → account row.
 * Vendor dispatch stays account-only; it is a dedicated column
 * (`manager_automation_settings.vendor_dispatch`), not an Operations
 * namespace, and this plan does not extend it.
 */
import { saveManagerAutomationSettings, normalizeManagerAutomationSettings, type ManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { clearReminderOverridesForUnpaidCharges } from "@/lib/payment-reminder-lifecycle.server";
import { loadVendorDispatchSettings, saveVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertAutomationSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
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
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const NAMESPACE = "paymentAutomation" as const;
const ANALYTICS_MODULE = "payment_automation";

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
): Promise<{ settings: ManagerAutomationSettings; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeManagerAutomationSettings, loadAccount: (d, m) => loadManagerAutomationSettings(d, m) },
  );
  return { settings: value, source };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    // The module-permission check and the scope-ownership check are
    // independent reads (neither's DB query depends on the other's result) —
    // running them in parallel instead of in sequence saves one full
    // round-trip off every call (part of Night QA finding #2's ~2.3-2.5s
    // warm latency on this route).
    const scope = resolveSettingsScopeParams(req.url);
    const [access, scopeAccess] = await Promise.all([
      assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read"),
      assertSettingsScopeOwned(ctx.db, ctx.userId, scope),
    ]);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;
    const [{ settings, source }, vendorDispatch, overriddenPropertyIds] = await Promise.all([
      loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId),
      loadVendorDispatchSettings(ctx.db, ownerUserId),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({
      settings,
      vendorDispatch,
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
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json()) as Record<string, unknown>;
    const { vendorDispatch: vendorDispatchPatch, applyReminderScope, propertyId: bodyPropertyId, workspaceId: bodyWorkspaceId, reset, ...rest } = body;
    const scope = resolveSettingsScopeParams(req.url, { propertyId: bodyPropertyId, workspaceId: bodyWorkspaceId });
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    let settings: ManagerAutomationSettings;
    let source: SettingsResolutionSource;
    let overriddenPropertyIds: string[] = [];

    if (reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      ({ settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId));
      overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
    } else if (Object.keys(rest).length > 0) {
      const { settings: current } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
      const normalized = normalizeManagerAutomationSettings({ ...current, ...rest });
      const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
      if (propertyId) {
        await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, normalized);
      } else if (workspaceId) {
        await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, normalized);
      } else {
        await saveManagerAutomationSettings(ctx.db, ownerUserId, normalized);
      }
      settings = normalized;
      source = rung;
      overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung, ownerUserId, workspaceId });
    } else {
      ({ settings, source } = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId));
      overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    }

    let clearedOverrides = 0;
    if (applyReminderScope === "future_and_existing") {
      clearedOverrides = await clearReminderOverridesForUnpaidCharges(ctx.db, ownerUserId);
    }

    let vendorDispatch = await loadVendorDispatchSettings(ctx.db, ownerUserId);
    if (vendorDispatchPatch && typeof vendorDispatchPatch === "object") {
      vendorDispatch = await saveVendorDispatchSettings(ctx.db, ownerUserId, {
        ...vendorDispatch,
        ...(vendorDispatchPatch as Record<string, unknown>),
      });
    }
    return NextResponse.json({
      settings,
      vendorDispatch,
      clearedOverrides,
      scope: propertyId ? "property" : "workspace",
      inherited: false,
      overriddenPropertyIds,
      source,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
