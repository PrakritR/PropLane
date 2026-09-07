import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { writeAdminBillingAudit, type AdminBillingAuditEntry } from "@/lib/admin-billing-audit.server";
import {
  loadManagerBillingOverrides,
  parseComplimentaryOverride,
  parsePropertyCapOverride,
  parseTrialEndOverride,
  saveManagerBillingOverrides,
  type ManagerBillingOverrides,
} from "@/lib/manager-billing-overrides";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * PropLane staff's per-account billing overrides: property cap, trial end, complimentary status.
 *
 * This route is the authorization boundary, exactly like `/api/admin/manager-service-fee`:
 * `saveManagerBillingOverrides` does no authorization of its own, matching every other service-role
 * writer here, so a non-admin let through here is caught by nothing downstream. The manager these
 * settings are about must not be able to call it either — a manager who could set their own
 * property cap would have no cap.
 *
 * Every accepted change writes an `audit_log` row per field (actor, manager, field, before → after,
 * optional reason), because the value alone never says who granted the exception or why.
 *
 * Of the three, only `propertyCap` is read by enforcement today. `trialEndsAt` and `complimentary`
 * are recorded and displayed only — no billing or plan resolver consults them yet — and the admin
 * screen says so beside each control rather than implying a switch that bills.
 */
async function requireAdminActor(): Promise<{ ok: true; actorId: string } | { ok: false }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdminUser(user.id))) return { ok: false };
  return { ok: true, actorId: user.id };
}

function readManagerId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export async function GET(req: Request) {
  try {
    if (!(await requireAdminActor()).ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const managerUserId = readManagerId(new URL(req.url).searchParams.get("managerUserId"));
    if (!managerUserId) {
      return NextResponse.json({ error: "managerUserId is required." }, { status: 400 });
    }
    const db = createSupabaseServiceRoleClient();
    const read = await loadManagerBillingOverrides(db, managerUserId);
    // An unreadable override is not an absent one. Reporting "nothing is set" would invite staff to
    // set a value on top of one they cannot see.
    if (!read.ok) return NextResponse.json({ error: read.error }, { status: 500 });
    return NextResponse.json({ managerUserId, overrides: read.overrides });
  } catch {
    return NextResponse.json({ error: "Could not load billing overrides." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const actor = await requireAdminActor();
    if (!actor.ok) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const managerUserId = readManagerId(body.managerUserId);
    if (!managerUserId) {
      return NextResponse.json({ error: "managerUserId is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const current = await loadManagerBillingOverrides(db, managerUserId);
    // Refuse rather than write on top of a state we could not read: the before-value is what makes
    // the audit row worth having, and a blind write could silently clear a cap staff had set.
    if (!current.ok) return NextResponse.json({ error: current.error }, { status: 500 });

    // Only the fields actually PRESENT in the body move. A PATCH that names one setting must not
    // clear the other two — and `null` is a real value here (clear), so absence is the only way to
    // say "leave it alone".
    const next: ManagerBillingOverrides = { ...current.overrides };
    const entries: AdminBillingAuditEntry[] = [];

    if ("propertyCap" in body) {
      const parsed = parsePropertyCapOverride(body.propertyCap);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (parsed.value !== current.overrides.propertyCap) {
        entries.push({ field: "propertyCap", before: current.overrides.propertyCap, after: parsed.value });
      }
      next.propertyCap = parsed.value;
    }

    if ("trialEndsAt" in body) {
      const parsed = parseTrialEndOverride(body.trialEndsAt);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (parsed.value !== current.overrides.trialEndsAt) {
        entries.push({ field: "trialEndsAt", before: current.overrides.trialEndsAt, after: parsed.value });
      }
      next.trialEndsAt = parsed.value;
    }

    if ("complimentary" in body) {
      const parsed = parseComplimentaryOverride(body.complimentary);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (parsed.value !== current.overrides.complimentary) {
        entries.push({ field: "complimentary", before: current.overrides.complimentary, after: parsed.value });
      }
      next.complimentary = parsed.value;
    }

    if (!("propertyCap" in body) && !("trialEndsAt" in body) && !("complimentary" in body)) {
      return NextResponse.json(
        { error: "Provide propertyCap, trialEndsAt, and/or complimentary to update." },
        { status: 400 },
      );
    }

    const saved = await saveManagerBillingOverrides(db, managerUserId, next);

    // The write has landed; the trail is best-effort from here. A failed insert is reported in the
    // response rather than swallowed, so a staff member is never told a change was recorded when
    // the only record of WHY is gone.
    let auditRecorded = true;
    if (entries.length > 0) {
      const audit = await writeAdminBillingAudit({
        db,
        actorUserId: actor.actorId,
        managerUserId,
        entries,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      auditRecorded = audit.ok;
    }

    return NextResponse.json({ ok: true, managerUserId, overrides: saved, auditRecorded });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save billing overrides.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
