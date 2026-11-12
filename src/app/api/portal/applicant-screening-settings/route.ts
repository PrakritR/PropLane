/**
 * Which applicant checks a listing offers: the ID check and the applicant-paid background check, as two separate
 * settings. Property override, then workspace, then the default (ON for a PropLane-managed workspace, OFF for
 * self-serve). Scope and authority are re-derived from the session (`assertSettingsScopeOwned`), never from a
 * body id. Applications, leases and tours stay free either way.
 */
import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
} from "@/lib/scope/settings-scope";
import { normalizeApplicantScreeningSettings } from "@/lib/screening/applicant-screening";
import {
  APPLICANT_SCREENING_NAMESPACE,
  resolveApplicantScreeningSettings,
} from "@/lib/screening/applicant-screening-settings.server";
import { ForeignPropertyError, savePropertyOverride } from "@/lib/settings/property-overrides.server";
import { saveWorkspaceNamespaceSettings } from "@/lib/settings/scope-resolver.server";

export const runtime = "nodejs";

function foreign(): NextResponse {
  return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManagerRouteUser({ fast: true });
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const scope = resolveSettingsScopeParams(req.url);
    const access = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope, { module: "applications", level: "read" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { settings, source, managed } = await resolveApplicantScreeningSettings(ctx.db, {
      managerUserId: access.ownerUserId,
      propertyId: access.propertyId,
      workspaceId: access.workspaceId,
    });
    return NextResponse.json({
      settings,
      source,
      managed,
      scope: access.propertyId ? "property" : "workspace",
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.idCheck !== "boolean" && typeof body.backgroundCheck !== "boolean" && body.idUnlock !== "clear" && body.idUnlock !== "order") {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }
    const scope = resolveSettingsScopeParams(req.url, body);
    const access = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope, { module: "applications", level: "edit" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { ownerUserId, propertyId, workspaceId } = access;
    if (!propertyId && !workspaceId) {
      return NextResponse.json({ error: "Choose a listing or a workspace." }, { status: 400 });
    }

    const current = await resolveApplicantScreeningSettings(ctx.db, { managerUserId: ownerUserId, propertyId, workspaceId });
    const next = normalizeApplicantScreeningSettings(
      {
        idCheck: typeof body.idCheck === "boolean" ? body.idCheck : current.settings.idCheck,
        backgroundCheck: typeof body.backgroundCheck === "boolean" ? body.backgroundCheck : current.settings.backgroundCheck,
        idUnlock: body.idUnlock === "clear" || body.idUnlock === "order" ? body.idUnlock : current.settings.idUnlock,
      },
      current.settings,
    );
    if (propertyId) {
      await savePropertyOverride(ctx.db, ownerUserId, propertyId, APPLICANT_SCREENING_NAMESPACE, next);
    } else if (workspaceId) {
      await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, APPLICANT_SCREENING_NAMESPACE, next);
    }
    return NextResponse.json({ settings: next, source: propertyId ? "property" : "workspace", managed: current.managed });
  } catch (e) {
    if (e instanceof ForeignPropertyError) return foreign();
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
