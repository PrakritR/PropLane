import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  listApplicationFeeWaiverCodes,
  pickPortfolioApplicationFeeWaiverCode,
  pickPrimaryApplicationFeeWaiverCode,
  previewApplicationFeeWaiverCodeWrite,
  setPrimaryApplicationFeeWaiverCode,
  upsertPropertyApplicationFeeWaiverCode,
  listingWaiverLabel,
} from "@/lib/application-fee-waiver";
import {
  loadManagerApplicationSettings,
  normalizeManagerApplicationSettings,
  saveManagerApplicationSettings,
  validateManagerApplicationFeeCents,
  type ApplicationFeeChargePolicy,
  type ManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import { suggestedManagerApplicationFeeCents } from "@/lib/manager-application-settings.server";
import {
  loadApplicationAutomation,
  loadApplicationAutomationState,
  saveApplicationAutomation,
  saveApplicationAutomationForProperty,
  resolveApplicationAutomationForProperty,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  loadTaskAutomation,
  normalizeTaskAutomation,
  saveTaskAutomation,
  type TaskAutomationPreferences,
} from "@/lib/task-automation-preferences";
import {
  loadManagerLandlordLegalNameFromProfile,
} from "@/lib/manager-landlord-profile";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";

export const runtime = "nodejs";


/**
 * Whose waiver codes this request may read or write for one property.
 *
 * A waiver code belongs to the LISTING, so a co-manager assigned to it must see
 * and edit the same code the owner does — scoping to the caller gave them a
 * blank field, and any code they set was stored under their own id where
 * redemption (which looks codes up under the property's owner) could never find
 * it. An unowned or unknown property falls back to the caller, which is exactly
 * the previous behaviour and exposes nothing new.
 *
 * A co-manager holding `{}` on this property must not read or rewrite the
 * owner's waiver code, which is why `assertCoManagerModuleAccess` resolves
 * through `coManagerModuleAllowed` rather than the retired empty-means-full
 * sentinel.
 */
async function resolveWaiverCodeScope(
  db: SupabaseClient,
  callerUserId: string,
  propertyId: string,
  level: "read" | "edit",
): Promise<
  | { ok: true; ownerUserId: string; callerIsOwner: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!propertyId) return { ok: true, ownerUserId: callerUserId, callerIsOwner: true };
  const { data } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .eq("id", propertyId)
    .maybeSingle();
  const ownerUserId = String((data as { manager_user_id?: string | null } | null)?.manager_user_id ?? "").trim();
  if (!ownerUserId || ownerUserId === callerUserId) {
    return { ok: true, ownerUserId: ownerUserId || callerUserId, callerIsOwner: true };
  }
  const access = await assertCoManagerModuleAccess(db as never, callerUserId, propertyId, "applications", {
    ownerManagerUserId: ownerUserId,
    level,
  });
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, ownerUserId, callerIsOwner: false };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const url = new URL(req.url);
    const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
    const settings = await loadManagerApplicationSettings(ctx.db, ctx.userId);
    const automationState = await loadApplicationAutomationState(ctx.db, ctx.userId);
    const automation = propertyId
      ? resolveApplicationAutomationForProperty(automationState, propertyId)
      : automationState.portfolio;
    const taskAutomation = await loadTaskAutomation(ctx.db, ctx.userId);
    const landlordLegalName = await loadManagerLandlordLegalNameFromProfile(ctx.db, ctx.userId);
    const landlord = { landlordLegalName };
    // Non-persisted suggestion the modal pre-fills so the manager confirms an
    // explicit value the first time (never a silent bulk change to what their
    // existing listings charge).
    const suggestedFeeCents = await suggestedManagerApplicationFeeCents(ctx.db, ctx.userId);
    const scope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId, "read");
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    const codes = await listApplicationFeeWaiverCodes(ctx.db, scope.ownerUserId);
    // NO fallback to the portfolio primary when a property is named. Falling
    // back showed a neighbouring listing's code under copy that reads "this
    // property's application" — and the field commits on blur, so it then
    // spread that code onto a property nobody set it for.
    const propertyWaiverCode = propertyId
      ? codes.find(
          (c) =>
            c.status === "active" &&
            (c.propertyId === propertyId || (c.propertyId == null && c.label === listingWaiverLabel(propertyId))),
        )?.code ?? null
      : pickPrimaryApplicationFeeWaiverCode(codes)?.code ?? null;
    // A legacy portfolio-wide code stays redeemable on THIS property (the row
    // lookup matches `property_id is null or property_id = p_property_id`), so
    // omitting it entirely shows an empty field over a live waiver. Reported
    // separately, and only to the owner, because the property-scoped field
    // cannot revoke it.
    const portfolioWaiverCode =
      propertyId && scope.callerIsOwner
        ? pickPortfolioApplicationFeeWaiverCode(codes)?.code ?? null
        : null;
    return NextResponse.json({
      settings,
      automation,
      automationState,
      taskAutomation,
      landlord,
      suggestedFeeCents,
      waiverCode: propertyWaiverCode,
      portfolioWaiverCode,
    });
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

    const propertyId =
      typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : "";

    // Authorize AND pre-validate the waiver portion of this PATCH before ANYTHING
    // is written. A mixed payload (`{ propertyId, applicationFeeCents, waiverCode }`)
    // used to persist the fee settings and only then discover the caller has no
    // `applications` edit on that property, or that the code collides — leaving a
    // partial save behind the 403/400. A rejected save must change nothing.
    let waiverWrite:
      | { raw: string; propertyId: string; ownerUserId: string; callerIsOwner: boolean }
      | null = null;
    if ("waiverCode" in body) {
      const raw = body.waiverCode == null ? "" : String(body.waiverCode);
      const scope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId, "edit");
      if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
      const preview = await previewApplicationFeeWaiverCodeWrite(ctx.db, scope.ownerUserId, propertyId, raw, {
        allowPortfolioConversion: scope.callerIsOwner,
      });
      if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 400 });
      waiverWrite = {
        raw,
        propertyId,
        ownerUserId: scope.ownerUserId,
        callerIsOwner: scope.callerIsOwner,
      };
    }

    // The automation flags share this route because they share the settings surface AND the
    // underlying row. A PATCH that names ONLY `automation` must leave the fee untouched: the
    // fee branch below reads an absent key as "clear it", so saving automation through that path
    // would silently zero the manager's application fee.
    let automation: ApplicationAutomationPreferences | undefined;
    if ("automation" in body) {
      automation = propertyId
        ? await saveApplicationAutomationForProperty(ctx.db, ctx.userId, propertyId, body.automation)
        : await saveApplicationAutomation(ctx.db, ctx.userId, body.automation);
    }

    let taskAutomation: TaskAutomationPreferences | undefined;
    if ("taskAutomation" in body) {
      taskAutomation = await saveTaskAutomation(ctx.db, ctx.userId, body.taskAutomation);
    }

    const feePatchRequested =
      "applicationFeeCents" in body ||
      "applicationFeeChargePolicy" in body ||
      "applicationFeeOtherEnabled" in body ||
      "applicationFeeOtherInstructions" in body ||
      "waiverCode" in body;
    if (!feePatchRequested) {
      return NextResponse.json({ automation, taskAutomation });
    }

    const existing = await loadManagerApplicationSettings(ctx.db, ctx.userId);

    const validated = validateManagerApplicationFeeCents(
      "applicationFeeCents" in body ? body.applicationFeeCents : existing.applicationFeeCents,
    );
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const rawPolicy = body.applicationFeeChargePolicy;
    const applicationFeeChargePolicy: ApplicationFeeChargePolicy =
      rawPolicy === "every_time" ? "every_time" : rawPolicy === "first_only" ? "first_only" : existing.applicationFeeChargePolicy;

    const instructionsRaw =
      "applicationFeeOtherInstructions" in body
        ? String(body.applicationFeeOtherInstructions ?? "").trim()
        : existing.applicationFeeOtherInstructions;
    const instructions = instructionsRaw.slice(0, 4000);
    const applicationFeeOtherEnabled =
      "applicationFeeOtherEnabled" in body
        ? body.applicationFeeOtherEnabled === true && instructions.length > 0
        : existing.applicationFeeOtherEnabled && instructions.length > 0;

    const nextSettings: ManagerApplicationSettings = normalizeManagerApplicationSettings({
      applicationFeeCents: validated.applicationFeeCents,
      applicationFeeChargePolicy,
      applicationFeeOtherEnabled,
      applicationFeeOtherInstructions: instructions,
    });
    const saved = await saveManagerApplicationSettings(ctx.db, ctx.userId, nextSettings);

    if (!waiverWrite) {
      return NextResponse.json({ settings: saved, automation, taskAutomation });
    }

    const result = waiverWrite.propertyId
      ? await upsertPropertyApplicationFeeWaiverCode(
          ctx.db,
          waiverWrite.ownerUserId,
          waiverWrite.propertyId,
          waiverWrite.raw,
          { allowPortfolioConversion: waiverWrite.callerIsOwner },
        )
      : await setPrimaryApplicationFeeWaiverCode(ctx.db, waiverWrite.ownerUserId, waiverWrite.raw);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ settings: saved, automation, taskAutomation, waiverCode: result.code?.code ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
