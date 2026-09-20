import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertAutomationSettingsCoManagerAccess, resolveSettingsPropertyOwner } from "@/lib/auth/manager-settings-module-access.server";
import { loadAutomatedMessageSettings, saveAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { automatedMessageDefaults } from "@/lib/automated-messages-defaults.server";
import {
  normalizeAutomatedMessageSettings,
  type AutomatedMessageSettings,
} from "@/lib/automated-messages-settings";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
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
  type ParsedSettingsScope,
} from "@/lib/scope/settings-scope";

export const runtime = "nodejs";

const NAMESPACE = "automatedMessages" as const;
const ANALYTICS_MODULE = "automated_messages";
// Mirrors `assertAutomationSettingsCoManagerAccess`'s own choice of module —
// this blob has no per-field "kind" tag to authorize against (see that
// function's docstring), so a house-scoped call is gated on the same one
// module, never the loosest available choice.
const AUTOMATED_MESSAGES_MODULE = "payments" as const;

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

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

type ScopeAccess =
  | { ok: true; ownerUserId: string; propertyId: string | null; workspaceId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Resolve which manager's row a scoped automated-messages call acts on, and
 * authorize it. A `propertyId` resolves (and authorizes) its owner first
 * through `resolveSettingsPropertyOwner` (PLAN-0916-1040) — the only rung
 * with co-manager delegation today. `assertSettingsScopeOwned` then runs
 * against that ALREADY-authorized owner purely to resolve the workspace id.
 * With no `propertyId`, a named `workspaceId` still requires literal
 * ownership, and the module check runs against the caller directly.
 */
async function resolveScope(
  ctx: { db: Db; userId: string },
  scope: ParsedSettingsScope,
  level: CoManagerPermissionLevel,
): Promise<ScopeAccess> {
  if (scope.propertyId) {
    const owner = await resolveSettingsPropertyOwner(ctx.db, ctx.userId, scope.propertyId, AUTOMATED_MESSAGES_MODULE, level);
    if (!owner.ok) return owner;
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, owner.ownerUserId, scope);
    if (!scopeAccess.ok) return scopeAccess;
    return { ok: true, ownerUserId: owner.ownerUserId, propertyId: scopeAccess.propertyId, workspaceId: scopeAccess.workspaceId };
  }
  const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
  if (!scopeAccess.ok) return scopeAccess;
  const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, level);
  if (!access.ok) return access;
  return { ok: true, ownerUserId: scopeAccess.ownerUserId, propertyId: scopeAccess.propertyId, workspaceId: scopeAccess.workspaceId };
}

async function loadCurrent(
  db: Db,
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
    const scope = resolveSettingsScopeParams(req.url);
    const access = await resolveScope(ctx, scope, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { ownerUserId, propertyId, workspaceId } = access;
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
    const body = (await req.json().catch(() => ({}))) as {
      settings?: unknown;
      propertyId?: unknown;
      workspaceId?: unknown;
      reset?: unknown;
    };
    const scope = resolveSettingsScopeParams(req.url, body);
    const access = await resolveScope(ctx, scope, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { ownerUserId, propertyId, workspaceId } = access;

    // Reset — clear the whole house override. Checked BEFORE the "no
    // property or workspace" branch, so `{ reset: true }` with no house
    // selected 400s instead of falling into that branch and being read as
    // "save these (garbage) account settings".
    if (body.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { settings, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ settings, scope: legacyScope(source), inherited: true, overriddenPropertyIds, source });
    }

    // No property or workspace → the account store (its own per-key merge).
    if (!propertyId && !workspaceId) {
      const settings = await saveAutomatedMessageSettings(ctx.db, ownerUserId, body.settings ?? body);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: "account", ownerUserId, workspaceId: null });
      return NextResponse.json({ settings, scope: "workspace", inherited: false, overriddenPropertyIds, source: "account" });
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
