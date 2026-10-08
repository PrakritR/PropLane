import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  normalizeAdminAuditReason,
  writeAdminBillingAudit,
  type AdminBillingAuditEntry,
} from "@/lib/admin-billing-audit.server";
import {
  applyAccountPromoCode,
  extendAccountTrial,
  setAccountComplimentary,
} from "@/lib/admin/admin-billing-actions.server";
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
 * reason), because the value alone never says who granted the exception or why.
 *
 * What each field does:
 *  - `propertyCap` is read by enforcement (the reason is optional).
 *  - `trialEndsAt`, `complimentary` and `promoCode` are LIVE (`admin-billing-actions.server.ts`):
 *    they change the Stripe subscription or the date the plan resolver reads, and each REQUIRES a
 *    reason, refused before anything is applied.
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

    const wantsCap = "propertyCap" in body;
    const wantsTrial = "trialEndsAt" in body;
    const wantsComp = "complimentary" in body;
    const wantsPromo = "promoCode" in body;
    if (!wantsCap && !wantsTrial && !wantsComp && !wantsPromo) {
      return NextResponse.json(
        { error: "Provide propertyCap, trialEndsAt, complimentary, and/or promoCode to update." },
        { status: 400 },
      );
    }

    // Everything is validated BEFORE anything is applied: a bad second field must not leave the
    // first one changed. The three live actions below also refuse a missing reason on their own;
    // checking here keeps that refusal ahead of the cap write.
    let capValue: number | null | undefined;
    if (wantsCap) {
      const parsed = parsePropertyCapOverride(body.propertyCap);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      capValue = parsed.value;
    }
    let compValue: boolean | undefined;
    if (wantsComp) {
      const parsed = parseComplimentaryOverride(body.complimentary);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      compValue = parsed.value;
    }
    if (wantsTrial) {
      const parsed = parseTrialEndOverride(body.trialEndsAt);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (parsed.value === null) {
        return NextResponse.json({ error: "Pick the date the trial should end." }, { status: 400 });
      }
    }
    if ((wantsTrial || wantsComp || wantsPromo) && !normalizeAdminAuditReason(body.reason)) {
      return NextResponse.json({ error: "A reason is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    let overrides: ManagerBillingOverrides | null = null;
    let auditRecorded = true;
    const reason = typeof body.reason === "string" ? body.reason : null;

    if (wantsCap) {
      const current = await loadManagerBillingOverrides(db, managerUserId);
      // Refuse rather than write on top of a state we could not read: the before-value is what makes
      // the audit row worth having, and a blind write could silently clear a cap staff had set.
      if (!current.ok) return NextResponse.json({ error: current.error }, { status: 500 });
      const next: ManagerBillingOverrides = { ...current.overrides, propertyCap: capValue ?? null };
      const entries: AdminBillingAuditEntry[] = [];
      if ((capValue ?? null) !== current.overrides.propertyCap) {
        entries.push({ field: "propertyCap", before: current.overrides.propertyCap, after: capValue ?? null });
      }
      overrides = await saveManagerBillingOverrides(db, managerUserId, next);
      // The write has landed; the trail is best-effort from here. A failed insert is reported in the
      // response rather than swallowed, so a staff member is never told a change was recorded when
      // the only record of WHY is gone.
      if (entries.length > 0) {
        const audit = await writeAdminBillingAudit({ db, actorUserId: actor.actorId, managerUserId, entries, reason });
        auditRecorded = auditRecorded && audit.ok;
      }
    }

    const ctx = { db, actorUserId: actor.actorId, managerUserId, reason };
    const results = [];
    if (wantsTrial) results.push(await extendAccountTrial(ctx, body.trialEndsAt));
    if (wantsComp) results.push(await setAccountComplimentary(ctx, compValue));
    if (wantsPromo) results.push(await applyAccountPromoCode(ctx, body.promoCode));
    for (const result of results) {
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      auditRecorded = auditRecorded && result.auditRecorded;
    }

    if (results.length > 0 || !overrides) {
      const read = await loadManagerBillingOverrides(db, managerUserId);
      if (read.ok) overrides = read.overrides;
    }
    return NextResponse.json({ ok: true, managerUserId, overrides, auditRecorded });
  } catch (e) {
    console.error("PATCH /api/admin/manager-billing-overrides failed", e);
    return NextResponse.json({ error: "Could not save billing overrides." }, { status: 500 });
  }
}
