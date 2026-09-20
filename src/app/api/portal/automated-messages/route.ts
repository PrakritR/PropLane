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
  resolveOperationsOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";

export const runtime = "nodejs";

const NAMESPACE = "automatedMessages" as const;

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
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const propertyId = readPropertyId(req.url);
    const [{ settings, scope, inherited }, overriddenPropertyIds] = await Promise.all([
      resolveOperationsOverride(ctx.db, ctx.userId, propertyId, NAMESPACE, {
        loadWorkspace: () => loadAutomatedMessageSettings(ctx.db, ctx.userId),
        normalize: normalizeAutomatedMessageSettings,
      }),
      listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE),
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
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json().catch(() => ({}))) as { settings?: unknown; propertyId?: unknown; reset?: unknown };
    const propertyId =
      typeof body.propertyId === "string" && body.propertyId.trim()
        ? body.propertyId.trim()
        : readPropertyId(req.url);

    // No property → the workspace store (its own per-key merge).
    if (!propertyId) {
      const settings = await saveAutomatedMessageSettings(ctx.db, ctx.userId, body.settings ?? body);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: false, overriddenPropertyIds });
    }

    // Reset — clear the whole house override.
    if (body.reset === true) {
      await clearPropertyOverride(ctx.db, ctx.userId, propertyId, NAMESPACE);
      const settings = await loadAutomatedMessageSettings(ctx.db, ctx.userId);
      const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE);
      return NextResponse.json({ settings, scope: "workspace", inherited: true, overriddenPropertyIds });
    }

    // House patch — merge onto the CURRENT effective settings (override or
    // workspace), then store the whole blob as this house's override.
    const { settings: current } = await resolveOperationsOverride(ctx.db, ctx.userId, propertyId, NAMESPACE, {
      loadWorkspace: () => loadAutomatedMessageSettings(ctx.db, ctx.userId),
      normalize: normalizeAutomatedMessageSettings,
    });
    const incoming = normalizeAutomatedMessageSettings(body.settings ?? body);
    const merged: AutomatedMessageSettings = { ...current, ...incoming };
    await savePropertyOverride(ctx.db, ctx.userId, propertyId, NAMESPACE, merged);
    const overriddenPropertyIds = await listPropertyOverrides(ctx.db, ctx.userId, NAMESPACE);
    return NextResponse.json({ settings: merged, scope: "property", inherited: false, overriddenPropertyIds });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
