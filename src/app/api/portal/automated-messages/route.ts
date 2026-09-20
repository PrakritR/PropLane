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
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  resolveOperationsOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";

export const runtime = "nodejs";

const NAMESPACE = "automatedMessages" as const;
// Mirrors `assertAutomationSettingsCoManagerAccess`'s own choice of module —
// this blob has no per-field "kind" tag to authorize against (see that
// function's docstring), so a house-scoped call is gated on the same one
// module, never the loosest available choice.
const AUTOMATED_MESSAGES_MODULE = "payments" as const;

function readPropertyId(url: string): string | null {
  const raw = new URL(url).searchParams.get("propertyId");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
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

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const propertyId = readPropertyId(req.url);
    let ownerUserId = ctx.userId;
    if (propertyId) {
      const owner = await resolveSettingsPropertyOwner(ctx.db, ctx.userId, propertyId, AUTOMATED_MESSAGES_MODULE, "read");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    } else {
      const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }
    const [{ settings, scope, inherited }, overriddenPropertyIds] = await Promise.all([
      resolveOperationsOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, {
        loadWorkspace: () => loadAutomatedMessageSettings(ctx.db, ownerUserId),
        normalize: normalizeAutomatedMessageSettings,
      }),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    return NextResponse.json({ settings, scope, inherited, overriddenPropertyIds, defaults: automatedMessageDefaults() });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { settings?: unknown; propertyId?: unknown; reset?: unknown };
    const propertyId =
      typeof body.propertyId === "string" && body.propertyId.trim()
        ? body.propertyId.trim()
        : readPropertyId(req.url);

    let ownerUserId = ctx.userId;
    if (propertyId) {
      const owner = await resolveSettingsPropertyOwner(ctx.db, ctx.userId, propertyId, AUTOMATED_MESSAGES_MODULE, "edit");
      if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
      ownerUserId = owner.ownerUserId;
    } else {
      const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // Reset — clear the whole house override. Checked BEFORE the "no
    // property" branch, so `{ reset: true }` with no house selected 400s
    // instead of falling into that branch and being read as "save these
    // (garbage) workspace settings" — the same ordering
    // `reminder-settings`/`task-automation-settings` already use.
    if (body.reset === true) {
      if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
      await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
      const settings = await loadAutomatedMessageSettings(ctx.db, ownerUserId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: true, overriddenPropertyIds });
    }

    // No property → the workspace store (its own per-key merge).
    if (!propertyId) {
      const settings = await saveAutomatedMessageSettings(ctx.db, ownerUserId, body.settings ?? body);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: false, overriddenPropertyIds });
    }

    // House patch — merge onto the CURRENT effective settings (override or
    // workspace), then store the whole blob as this house's override.
    const { settings: current } = await resolveOperationsOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, {
      loadWorkspace: () => loadAutomatedMessageSettings(ctx.db, ownerUserId),
      normalize: normalizeAutomatedMessageSettings,
    });
    const incoming = normalizeAutomatedMessageSettings(body.settings ?? body);
    const merged: AutomatedMessageSettings = { ...current, ...incoming };
    await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, merged);
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE);
    return NextResponse.json({ settings: merged, scope: "property", inherited: false, overriddenPropertyIds });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
