/**
 * Per-manager lifecycle task rules.
 *
 * Mirrors the other portal settings routes: manager-only, service-role write
 * pinned to the authenticated user's id, and the payload re-normalized
 * server-side so a hand-crafted request cannot store an out-of-range deadline
 * or a task key the generator does not know.
 *
 * `?propertyId=` / `?workspaceId=` resolve property override → workspace row
 * → account row (PLAN-0920-0845). `scope` keeps its pre-existing two-value
 * meaning; `source` is the new three-value truthful tag.
 */
import { NextResponse } from "next/server";
import {
  loadLifecycleAutomation,
  saveLifecycleAutomation,
} from "@/lib/task-lifecycle-automation.server";
import { normalizeLifecycleAutomation, type LifecycleTaskAutomation } from "@/lib/task-lifecycle-automation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTaskAutomationCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
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

const NAMESPACE = "lifecycleTasks" as const;
const ANALYTICS_MODULE = "task_automation";

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

function legacyScope(source: SettingsResolutionSource): "property" | "workspace" {
  return source === "property" ? "property" : "workspace";
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
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

async function loadCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ automation: LifecycleTaskAutomation; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeLifecycleAutomation, loadAccount: (d, m) => loadLifecycleAutomation(d, m) },
  );
  return { automation: value, source };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertTaskAutomationCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;
    const [{ automation, source }, overriddenPropertyIds] = await Promise.all([
      loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({
      automation,
      scope: legacyScope(source),
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
    const access = await assertTaskAutomationCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json().catch(() => ({}))) as {
      automation?: unknown;
      propertyId?: unknown;
      workspaceId?: unknown;
      reset?: unknown;
    };
    const scope = resolveSettingsScopeParams(req.url, body);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

    // Reset — clear the whole house override, back to workspace/account values.
    if (body.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const { automation, source } = await loadCurrent(ctx.db, ownerUserId, null, workspaceId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung: writeRungFromSource(source), ownerUserId, workspaceId });
      return NextResponse.json({ automation, scope: legacyScope(source), inherited: true, overriddenPropertyIds, source });
    }

    const incoming =
      body.automation && typeof body.automation === "object" && !Array.isArray(body.automation)
        ? (body.automation as Record<string, unknown>)
        : {};
    // Merge onto the CURRENT scope so a partial patch cannot blank sibling rules,
    // and a house patch edits that house's own override — never the workspace/account.
    const { settings: current } = await (async () => {
      const resolved = await loadCurrent(ctx.db, ownerUserId, propertyId, workspaceId);
      return { settings: resolved.automation };
    })();
    const nextAutomation = normalizeLifecycleAutomation({ ...current, ...incoming });
    const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
    if (propertyId) {
      await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, nextAutomation);
    } else if (workspaceId) {
      await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, nextAutomation);
    } else {
      await saveLifecycleAutomation(ctx.db, ownerUserId, nextAutomation);
    }
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, { module: ANALYTICS_MODULE, rung, ownerUserId, workspaceId });
    return NextResponse.json({
      automation: nextAutomation,
      scope: propertyId ? ("property" as const) : ("workspace" as const),
      inherited: false,
      overriddenPropertyIds,
      source: rung,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
