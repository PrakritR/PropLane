import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveSettingsScope, saveWorkspaceNamespaceSettings } from "@/lib/settings/scope-resolver.server";
import { assertSettingsScopeOwned, resolveSettingsScopeParams, trackSettingsScopeChanged } from "@/lib/scope/settings-scope";
import {
  emptyWorkspaceApplicationFormTemplate,
  normalizeWorkspaceApplicationFormTemplate,
  workspaceApplicationFormIsConfigured,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";
import { pushWorkspaceApplicationFormToFollowingListings } from "@/lib/rental-application/apply-workspace-application-form-to-listings.server";

export const runtime = "nodejs";

const NAMESPACE = "applicationFormTemplate" as const;
const ANALYTICS_MODULE = "application_form_template";

/**
 * The workspace-wide rental application template — no property-override
 * rung (a listing opts out entirely with its own `applicationFormSource`,
 * a listing-level concept, not a settings-scope override of this
 * namespace). A request with no `workspaceId` resolves to the owner's
 * default workspace, since this settings page has no per-property picker.
 */
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

async function loadTemplate(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
): Promise<WorkspaceApplicationFormTemplate> {
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId: ownerUserId, workspaceId },
    NAMESPACE,
    { normalize: (raw) => normalizeWorkspaceApplicationFormTemplate(raw) ?? emptyWorkspaceApplicationFormTemplate() },
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
      const template = emptyWorkspaceApplicationFormTemplate();
      return NextResponse.json({ template, workspaceId: null, configured: false });
    }
    const template = await loadTemplate(ctx.db, ownerUserId, workspaceId);
    return NextResponse.json({ template, workspaceId, configured: workspaceApplicationFormIsConfigured(template) });
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
    if (!("template" in body) || typeof body.template !== "object" || body.template === null) {
      return NextResponse.json({ error: "Missing template." }, { status: 400 });
    }
    const current = await loadTemplate(ctx.db, ownerUserId, workspaceId);
    const incoming = normalizeWorkspaceApplicationFormTemplate({
      ...current,
      ...(body.template as Record<string, unknown>),
    }) ?? emptyWorkspaceApplicationFormTemplate();
    incoming.updatedAt = new Date().toISOString();
    await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, incoming);
    // Copy-on-save (docs/agents/listing-wizard-defaults.md § Workspace
    // application form): push the just-saved template onto every listing in
    // this workspace still following it, so a listing's application stops
    // silently changing under an applicant mid-apply. The live-read fallback
    // in publicListingProjection / server-side validation / the editor
    // preview stays in place for anything this push misses.
    await pushWorkspaceApplicationFormToFollowingListings(ctx.db, workspaceId, incoming);
    await trackSettingsScopeChanged(ctx.db, ctx.userId, {
      module: ANALYTICS_MODULE,
      rung: "workspace",
      ownerUserId,
      workspaceId,
    });
    return NextResponse.json({ template: incoming, workspaceId, configured: workspaceApplicationFormIsConfigured(incoming) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
