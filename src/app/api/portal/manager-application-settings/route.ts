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
  normalizeApplicationAutomation,
  type ApplicationAutomationPreferences,
} from "@/lib/application-automation-preferences";
import {
  loadTaskAutomation,
  saveTaskAutomation,
  type TaskAutomationPreferences,
} from "@/lib/task-automation-preferences";
import {
  loadManagerLandlordLegalNameFromProfile,
} from "@/lib/manager-landlord-profile";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";
import {
  clearPropertyOverride,
  ForeignPropertyError,
  listPropertyOverrides,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";
import {
  resolveSettingsScope,
  saveWorkspaceNamespaceSettings,
  type SettingsResolutionSource,
} from "@/lib/settings/scope-resolver.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
  trackSettingsScopeChanged,
  writeRungFromSource,
} from "@/lib/scope/settings-scope";

export const runtime = "nodejs";

const NAMESPACE = "applicationAutomation" as const;
const ANALYTICS_MODULE = "application_automation";

/**
 * `automation` (the `applicationAutomation` namespace) now resolves property
 * override → workspace row → account row through the shared resolver
 * (PLAN-0920-0845), replacing the bespoke `applicationAutomationByPropertyId`
 * sidecar this route used to read/write directly — the ONLY caller of that
 * sidecar's resolve/save functions in the whole codebase, so nothing else
 * observes the change. `loadApplicationAutomationState` (and its
 * `automationState` response field) still reads the OLD sidecar for backward
 * compatibility with existing UI; it stops changing once a manager saves
 * through this route, and Phase D should retire it.
 */
async function loadCurrentAutomation(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null,
  workspaceId: string | null,
): Promise<{ automation: ApplicationAutomationPreferences; source: SettingsResolutionSource }> {
  const { value, source } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId, workspaceId },
    NAMESPACE,
    { normalize: normalizeApplicationAutomation, loadAccount: (d, m) => loadApplicationAutomation(d, m) },
  );
  return { automation: value, source };
}


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
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;
    const settings = await loadManagerApplicationSettings(ctx.db, ownerUserId);
    // `automationState` is kept for backward compatibility — see the header
    // comment above `loadCurrentAutomation`; `automation` itself now comes
    // from the shared resolver.
    const automationState = await loadApplicationAutomationState(ctx.db, ownerUserId);
    const [{ automation, source }, overriddenPropertyIds] = await Promise.all([
      loadCurrentAutomation(ctx.db, ownerUserId, propertyId, workspaceId),
      listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE),
    ]);
    const taskAutomation = await loadTaskAutomation(ctx.db, ownerUserId);
    const landlordLegalName = await loadManagerLandlordLegalNameFromProfile(ctx.db, ownerUserId);
    const landlord = { landlordLegalName };
    // Non-persisted suggestion the modal pre-fills so the manager confirms an
    // explicit value the first time (never a silent bulk change to what their
    // existing listings charge).
    const suggestedFeeCents = await suggestedManagerApplicationFeeCents(ctx.db, ownerUserId);
    const waiverScope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId ?? "", "read");
    if (!waiverScope.ok) return NextResponse.json({ error: waiverScope.error }, { status: waiverScope.status });
    const codes = await listApplicationFeeWaiverCodes(ctx.db, waiverScope.ownerUserId);
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
      propertyId && waiverScope.callerIsOwner
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
      scope: propertyId ? "property" : "workspace",
      inherited: Boolean(propertyId) && source !== "property",
      overriddenPropertyIds,
      source,
    });
  } catch (e) {
    if (e instanceof ForeignPropertyError) {
      return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
    }
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
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { ownerUserId, propertyId, workspaceId } = scopeAccess;

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
      const waiverScope = await resolveWaiverCodeScope(ctx.db, ctx.userId, propertyId ?? "", "edit");
      if (!waiverScope.ok) return NextResponse.json({ error: waiverScope.error }, { status: waiverScope.status });
      const preview = await previewApplicationFeeWaiverCodeWrite(ctx.db, waiverScope.ownerUserId, propertyId ?? "", raw, {
        allowPortfolioConversion: waiverScope.callerIsOwner,
      });
      if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 400 });
      waiverWrite = {
        raw,
        propertyId: propertyId ?? "",
        ownerUserId: waiverScope.ownerUserId,
        callerIsOwner: waiverScope.callerIsOwner,
      };
    }

    // The automation flags share this route because they share the settings surface AND the
    // underlying row. A PATCH that names ONLY `automation` must leave the fee untouched: the
    // fee branch below reads an absent key as "clear it", so saving automation through that path
    // would silently zero the manager's application fee.
    let automation: ApplicationAutomationPreferences | undefined;
    let automationSource: SettingsResolutionSource | undefined;
    if ("automation" in body) {
      if (body.reset === true) {
        if (!propertyId) return NextResponse.json({ error: "Reset needs a property." }, { status: 400 });
        await clearPropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE);
        const resolved = await loadCurrentAutomation(ctx.db, ownerUserId, null, workspaceId);
        automation = resolved.automation;
        automationSource = resolved.source;
      } else {
        const { automation: current } = await loadCurrentAutomation(ctx.db, ownerUserId, propertyId, workspaceId);
        const incoming = normalizeApplicationAutomation({ ...current, ...(body.automation as Record<string, unknown>) });
        const rung: "property" | "workspace" | "account" = propertyId ? "property" : workspaceId ? "workspace" : "account";
        if (propertyId) {
          await savePropertyOverride(ctx.db, ownerUserId, propertyId, NAMESPACE, incoming);
        } else if (workspaceId) {
          await saveWorkspaceNamespaceSettings(ctx.db, workspaceId, ownerUserId, NAMESPACE, incoming);
        } else {
          await saveApplicationAutomation(ctx.db, ownerUserId, incoming);
        }
        automation = incoming;
        automationSource = rung;
      }
      await trackSettingsScopeChanged(ctx.db, ctx.userId, {
        module: ANALYTICS_MODULE,
        rung: automationSource ? writeRungFromSource(automationSource) : "account",
        ownerUserId,
        workspaceId,
      });
    }

    let taskAutomation: TaskAutomationPreferences | undefined;
    if ("taskAutomation" in body) {
      taskAutomation = await saveTaskAutomation(ctx.db, ownerUserId, body.taskAutomation);
    }

    const overriddenPropertyIds = automation !== undefined ? await listPropertyOverrides(ctx.db, ownerUserId, NAMESPACE) : undefined;
    const automationFields = {
      automation,
      ...(automationSource ? { source: automationSource, scope: propertyId ? "property" : "workspace", inherited: false } : {}),
      ...(overriddenPropertyIds ? { overriddenPropertyIds } : {}),
    };

    const feePatchRequested =
      "applicationFeeCents" in body ||
      "applicationFeeChargePolicy" in body ||
      "waiverCode" in body;
    if (!feePatchRequested) {
      return NextResponse.json({ ...automationFields, taskAutomation });
    }

    const existing = await loadManagerApplicationSettings(ctx.db, ownerUserId);

    const validated = validateManagerApplicationFeeCents(
      "applicationFeeCents" in body ? body.applicationFeeCents : existing.applicationFeeCents,
    );
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const rawPolicy = body.applicationFeeChargePolicy;
    const applicationFeeChargePolicy: ApplicationFeeChargePolicy =
      rawPolicy === "every_time" ? "every_time" : rawPolicy === "first_only" ? "first_only" : existing.applicationFeeChargePolicy;

    const nextSettings: ManagerApplicationSettings = normalizeManagerApplicationSettings({
      applicationFeeCents: validated.applicationFeeCents,
      applicationFeeChargePolicy,
    });
    const saved = await saveManagerApplicationSettings(ctx.db, ownerUserId, nextSettings);

    if (!waiverWrite) {
      return NextResponse.json({ settings: saved, ...automationFields, taskAutomation });
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
    return NextResponse.json({ settings: saved, ...automationFields, taskAutomation, waiverCode: result.code?.code ?? null });
  } catch (e) {
    if (e instanceof ForeignPropertyError) {
      return NextResponse.json({ error: "That property is not in your workspace." }, { status: 403 });
    }
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
