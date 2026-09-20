/**
 * Per-manager lifecycle task rules.
 *
 * Mirrors the other portal settings routes: manager-only, service-role write
 * pinned to the authenticated user's id, and the payload re-normalized
 * server-side so a hand-crafted request cannot store an out-of-range deadline
 * or a task key the generator does not know.
 */
import { NextResponse } from "next/server";
import {
  loadLifecycleAutomation,
  saveLifecycleAutomation,
} from "@/lib/task-lifecycle-automation.server";
import { normalizeLifecycleAutomation } from "@/lib/task-lifecycle-automation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTaskAutomationCoManagerAccess, resolveSettingsPropertyOwner } from "@/lib/auth/manager-settings-module-access.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  resolveOperationsOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";

export const runtime = "nodejs";

const NAMESPACE = "lifecycleTasks" as const;
const TASK_AUTOMATION_MODULE = REMINDER_SUBJECT_CO_MANAGER_MODULE.task;

function readPropertyId(url: string): string | null {
  const raw = new URL(url).searchParams.get("propertyId");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

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
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const propertyId = readPropertyId(req.url);
    let ownerUserId = ctx.userId;
    if (propertyId) {
      const owner = await resolveSettingsPropertyOwner(ctx.db, ctx.userId, propertyId, TASK_AUTOMATION_MODULE, "read");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    } else {
      const access = await assertTaskAutomationCoManagerAccess(ctx.db, ctx.userId, "read");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }
    const [{ settings: automation, scope, inherited }, overriddenPropertyIds] = await Promise.all([
      resolveOperationsOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, {
        loadWorkspace: () => loadLifecycleAutomation(ctx.db, ownerUserId),
        normalize: normalizeLifecycleAutomation,
      }),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({ automation, scope, inherited, overriddenPropertyIds });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { automation?: unknown; propertyId?: unknown; reset?: unknown };
    const propertyId =
      typeof body.propertyId === "string" && body.propertyId.trim()
        ? body.propertyId.trim()
        : readPropertyId(req.url);

    let ownerUserId = ctx.userId;
    if (propertyId) {
      const owner = await resolveSettingsPropertyOwner(ctx.db, ctx.userId, propertyId, TASK_AUTOMATION_MODULE, "edit");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    } else {
      const access = await assertTaskAutomationCoManagerAccess(ctx.db, ctx.userId, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // Reset — clear the whole house override, back to workspace values.
    if (body.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const automation = await loadLifecycleAutomation(ctx.db, ownerUserId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ automation, scope: "workspace", inherited: true, overriddenPropertyIds });
    }

    const incoming =
      body.automation && typeof body.automation === "object" && !Array.isArray(body.automation)
        ? (body.automation as Record<string, unknown>)
        : {};
    // Merge onto the CURRENT scope so a partial patch cannot blank sibling rules,
    // and a house patch edits that house's own override — never the workspace.
    const { settings: current } = await resolveOperationsOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, {
      loadWorkspace: () => loadLifecycleAutomation(ctx.db, ownerUserId),
      normalize: normalizeLifecycleAutomation,
    });
    const nextAutomation = normalizeLifecycleAutomation({ ...current, ...incoming });
    if (propertyId) {
      await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, nextAutomation);
    } else {
      await saveLifecycleAutomation(ctx.db, ownerUserId, nextAutomation);
    }
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    return NextResponse.json({
      automation: nextAutomation,
      scope: propertyId ? "property" : "workspace",
      inherited: false,
      overriddenPropertyIds,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
