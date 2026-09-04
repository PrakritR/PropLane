import { NextResponse } from "next/server";

import {
  listApplicationFeeWaiverCodes,
  pickPrimaryApplicationFeeWaiverCode,
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

export const runtime = "nodejs";

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
    const codes = await listApplicationFeeWaiverCodes(ctx.db, ctx.userId);
    const primary = pickPrimaryApplicationFeeWaiverCode(codes);
    const propertyWaiverCode = propertyId
      ? codes.find((c) => c.label === listingWaiverLabel(propertyId) && c.status === "active")?.code ?? null
      : null;
    return NextResponse.json({
      settings,
      automation,
      automationState,
      taskAutomation,
      landlord,
      suggestedFeeCents,
      waiverCode: propertyWaiverCode ?? primary?.code ?? null,
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

    // The automation flags share this route because they share the settings surface AND the
    // underlying row. A PATCH that names ONLY `automation` must leave the fee untouched: the
    // fee branch below reads an absent key as "clear it", so saving automation through that path
    // would silently zero the manager's application fee.
    let automation: ApplicationAutomationPreferences | undefined;
    const propertyId =
      typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : "";
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

    if (!("waiverCode" in body)) {
      return NextResponse.json({ settings: saved, automation, taskAutomation });
    }

    const raw = body.waiverCode == null ? "" : String(body.waiverCode);
    const waiverPropertyId =
      typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : "";
    const result = waiverPropertyId
      ? await upsertPropertyApplicationFeeWaiverCode(ctx.db, ctx.userId, waiverPropertyId, raw)
      : await setPrimaryApplicationFeeWaiverCode(ctx.db, ctx.userId, raw);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ settings: saved, automation, taskAutomation, waiverCode: result.code?.code ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
