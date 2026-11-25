import { NextResponse } from "next/server";
import {
  RESIDENT_WELCOME_EMAIL_RE,
  canSendResidentWelcome,
  deliverResidentWelcome,
} from "@/lib/resident-welcome.server";
import {
  assertManagerCommunicationAllowedForActiveWorkspace,
  communicationRefusalBody,
} from "@/lib/manager-communication-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { loadServiceStaffScope } from "@/lib/service/service-mode.server";
import { serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";
import { resolveManagedApplicationOwner } from "@/lib/auth/managed-application-owner.server";
import { proplaneIdLookupVariants } from "@/lib/manager-id";

export const runtime = "nodejs";

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    let body: { to?: unknown; residentName?: unknown; axisId?: unknown; note?: unknown };
    try {
      body = (await req.json()) as { to?: unknown; residentName?: unknown; axisId?: unknown; note?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    let to = normalizeEmail(body.to);
    let residentName = typeof body.residentName === "string" ? body.residentName.trim() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";
    const note = typeof body.note === "string" ? body.note : "";

    if (!to || !RESIDENT_WELCOME_EMAIL_RE.test(to)) {
      return NextResponse.json({ error: "A valid recipient email is required." }, { status: 400 });
    }
    if (!axisId) {
      return NextResponse.json({ error: "Axis ID is required." }, { status: 400 });
    }

    const svc = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, svc)).kind === "denied") {
      return NextResponse.json({ error: "Resident access is unavailable for this account." }, { status: 403 });
    }
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (requestorError || !requestor) {
      return NextResponse.json({ error: requestorError?.message ?? "Profile not found." }, { status: 403 });
    }

    if (!canSendResidentWelcome(requestor.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    // A live signup trial has no Communication until it pays (the active workspace OWNER's plan).
    // This route only sends, so it refuses before a setup token is minted or anything is delivered.
    const communication = await assertManagerCommunicationAllowedForActiveWorkspace(svc, user.id);
    if (!communication.allowed) {
      return NextResponse.json(communicationRefusalBody(communication), { status: communication.status });
    }

    let ownerId = user.id;
    const scope = await loadServiceStaffScope(svc, user.id);
    if (scope) {
      const access = await serviceStaffSettingsAccess(svc, user.id, scope.workspaceId, "read");
      if (access.kind !== "ok") return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      const { data, error } = await svc.from("manager_application_records")
        .select("id, manager_user_id, property_id, assigned_property_id, resident_email, row_data")
        .in("id", proplaneIdLookupVariants(axisId)).eq("manager_user_id", access.ownerUserId).limit(1);
      const record = data?.[0];
      if (error || !record) return NextResponse.json({ error: "Resident record not found." }, { status: 404 });
      const propertyIds = new Set([record.property_id, record.assigned_property_id]
        .filter((id): id is string => typeof id === "string" && Boolean(id.trim())));
      const authorized = await resolveManagedApplicationOwner(svc, user.id, propertyIds, record.manager_user_id);
      if (!authorized?.ok || authorized.owner !== access.ownerUserId) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      ownerId = authorized.owner;
      to = normalizeEmail(record.resident_email);
      residentName = String(record.row_data?.name ?? "").trim();
      if (!RESIDENT_WELCOME_EMAIL_RE.test(to)) return NextResponse.json({ error: "A valid resident email is required on the record." }, { status: 400 });
    }
    const result = await deliverResidentWelcome(
      svc,
      { userId: ownerId, email: user.email ?? null },
      { to, residentName: residentName || undefined, axisId, note: note || undefined },
    );

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, mailtoHref: result.mailtoHref },
        { status: result.status },
      );
    }

    return NextResponse.json({ ok: true, id: result.id, skipped: result.skipped });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send welcome email." },
      { status: 500 },
    );
  }
}
