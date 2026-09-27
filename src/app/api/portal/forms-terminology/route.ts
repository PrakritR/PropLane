import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveSettingsScope, saveWorkspaceNamespaceSettings } from "@/lib/settings/scope-resolver.server";
import { assertSettingsScopeOwned, resolveSettingsScopeParams, trackSettingsScopeChanged } from "@/lib/scope/settings-scope";
import {
  emptyFormsTerminology,
  normalizeFormsTerminology,
  type FormsTerminology,
} from "@/lib/rental-application/forms-terminology";

export const runtime = "nodejs";

const NAMESPACE = "formsTerminology" as const;
const ANALYTICS_MODULE = "forms_terminology";

/** Same "no per-property picker on this settings page" shape as `application-form`. */
async function resolveDefaultWorkspaceId(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  return data?.id ? String(data.id) : null;
}

async function loadTerminology(db: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<FormsTerminology> {
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId: ownerUserId, workspaceId },
    NAMESPACE,
    { normalize: (raw) => normalizeFormsTerminology(raw) ?? emptyFormsTerminology() },
  );
  return value;
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope, { module: "applications", level: "read" });
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId } = scopeAccess;
    const workspaceId = scopeAccess.workspaceId ?? (await resolveDefaultWorkspaceId(ctx.db, ownerUserId));
    if (!workspaceId) {
      return NextResponse.json({ terminology: emptyFormsTerminology(), workspaceId: null });
    }
    const terminology = await loadTerminology(ctx.db, ownerUserId, workspaceId);
    return NextResponse.json({ terminology, workspaceId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const scope = resolveSettingsScopeParams(req.url, body);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope, { module: "applications", level: "edit" });
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId } = scopeAccess;
    const workspaceId = scopeAccess.workspaceId ?? (await resolveDefaultWorkspaceId(ctx.db, ownerUserId));
    if (!workspaceId) {
      return NextResponse.json({ error: "No workspace found for this account." }, { status: 400 });
    }
    if (!("terminology" in body) || typeof body.terminology !== "object" || body.terminology === null) {
      return NextResponse.json({ error: "Missing terminology." }, { status: 400 });
    }
    const incoming = normalizeFormsTerminology(body.terminology) ?? emptyFormsTerminology();
    incoming.updatedAt = new Date().toISOString();
    await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, incoming);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, {
      module: ANALYTICS_MODULE,
      rung: "workspace",
      ownerUserId,
      workspaceId,
    });
    return NextResponse.json({ terminology: incoming, workspaceId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
