import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { loadServiceStaffScope } from "@/lib/service/service-mode.server";
import { serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";
import { managerCanAccessLeaseRecord, managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { occupancyEntriesForManager } from "@/lib/occupancy/snapshot.server";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { propertyFromRecord } from "@/lib/lease-amendment.server";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { monthlyFeesBilledSeparately, monthlyRentFoldInTotal } from "@/lib/rent-fold-in";
import { submissionWithApplicationRoomFees } from "@/lib/room-term-fees";
import { utilitiesBillableMonthlyAmount } from "@/lib/listing-utilities-payment";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { parseMoneyAmount } from "@/lib/parse-money";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { residentNoticeChannel } from "@/lib/resident-notice-channel.server";
import { emitActionEvent } from "@/lib/action-events.server";
import { extensionCurrentEnd, creditPrebilledExtension, priceStayExtension, stayDatePlus, validStayDate, type ExtensionCharge, type ExtensionLine } from "@/lib/lease-stay-extension";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class StayExtensionError extends Error { constructor(message: string, public status = 409) { super(message); } }
export type StayExtension = { id: string; leaseId: string; previousEnd: string; newEnd: string; checkout: string; createdAt: string; actorId: string; lines: ExtensionLine[]; totalCents: number; chargeIds: string[] };

export async function authorizeStayExtension(db: SupabaseClient, actorId: string, leaseId: string) {
  const result = await db.from("portal_lease_pipeline_records").select("id,manager_user_id,property_id,resident_email,row_data").eq("id", leaseId).maybeSingle();
  if (result.error) throw new StayExtensionError("Could not read the lease.", 503);
  const record = result.data;
  if (!record?.manager_user_id || !record.property_id) throw new StayExtensionError("Lease not found.", 404);
  const scope = await loadServiceStaffScope(db, actorId);
  let allowed = false;
  if (scope) {
    if (scope.propertyIds.includes(record.property_id)) {
      const access = await serviceStaffSettingsAccess(db, actorId, scope.workspaceId, "read");
      allowed = access.kind === "ok" && access.ownerUserId === record.manager_user_id && (access.fullGrant ||
        await managerHasCoManagerPermissionForProperty(db, actorId, record.property_id, "leases", "edit", { strict: true }));
    }
  } else {
    const properties = await activeWorkspacePropertyScope(db, actorId);
    allowed = (properties === null || properties.includes(record.property_id)) && await managerCanAccessLeaseRecord(db, actorId, record, "edit");
  }
  if (!allowed) throw new StayExtensionError("Lease not found in this workspace.", 404);
  return record as { id: string; manager_user_id: string; property_id: string; resident_email: string; row_data: LeasePipelineRow };
}

export async function prepareStayExtension(db: SupabaseClient, actorId: string, leaseId: string, checkout: string) {
  const record = await authorizeStayExtension(db, actorId, leaseId);
  if (!validStayDate(checkout)) throw new StayExtensionError("Choose a valid checkout date.", 400);
  const id = `ext_${hash([leaseId, checkout]).slice(0, 32)}`;
  const prior = await db.from("lease_stay_extensions").select("row_data").eq("id", id).eq("manager_user_id", record.manager_user_id).maybeSingle();
  if (prior.error) throw new StayExtensionError("Could not read extension history.", 503);
  if (prior.data) return { record, existing: prior.data.row_data as StayExtension };
  const lease = record.row_data;
  if (lease.status === "Voided" || lease.pendingRenewal) throw new StayExtensionError("Resolve the voided lease or pending renewal before extending.");
  const owner = record.manager_user_id, propertyId = record.property_id;
  const appId = normalizeApplicationAxisId(lease.axisId ?? "");
  if (!appId) throw new StayExtensionError("Link this lease to its resident before extending.");
  const [appResult, houseResult, chargesResult, profilesResult] = await Promise.all([
    db.from("manager_application_records").select("id,row_data").eq("manager_user_id", owner).eq("id", appId).maybeSingle(),
    db.from("manager_property_records").select("id,manager_user_id,property_data,row_data,occupancy_revision").eq("id", propertyId).eq("manager_user_id", owner).maybeSingle(),
    db.from("portal_household_charge_records").select("id,row_data").eq("manager_user_id", owner).eq("property_id", propertyId).eq("resident_email", record.resident_email.toLowerCase()).order("id").limit(2000),
    db.from("portal_recurring_rent_profile_records").select("row_data").eq("manager_user_id", owner).eq("property_id", propertyId).eq("resident_email", record.resident_email.toLowerCase()).eq("active", true).limit(2),
  ]);
  if (appResult.error || houseResult.error || chargesResult.error || profilesResult.error || !appResult.data || !houseResult.data || chargesResult.data.length >= 2000 || profilesResult.data.length > 1) throw new StayExtensionError("Could not verify resident, room and billing records.", 503);
  const applicant = appResult.data.row_data as DemoApplicantRow;
  if (applicant.bucket !== "approved" || applicant.withdrawnAt || (applicant.assignedPropertyId || applicant.application?.propertyId) !== propertyId) throw new StayExtensionError("Only a current approved resident can extend this stay.");
  const choice = applicant.assignedRoomChoice || applicant.application?.roomChoice1 || lease.roomChoice;
  if (!choice?.startsWith(`${propertyId}::`) || choice !== lease.roomChoice) throw new StayExtensionError("The resident and lease must identify the same room.");
  const roomId = choice.slice(propertyId.length + 2);
  const property = propertyFromRecord(houseResult.data);
  const submission = property?.listingSubmission ? normalizeManagerListingSubmissionV1(property.listingSubmission) : null;
  const room = submission?.rooms.find((r) => r.id === roomId);
  if (!property || !submission || !room) throw new StayExtensionError("Could not verify this room's pricing.");
  if (applicant.application?.bundleId || lease.jointLeaseBundleId) throw new StayExtensionError("Extend a bundled household through Send new lease.");
  const occupancy = await occupancyEntriesForManager(db, owner, { propertyIds: [propertyId] });
  const own = (e: (typeof occupancy.entries)[number]) => e.leaseId === leaseId || (!!e.applicationId && normalizeApplicationAxisId(e.applicationId) === appId);
  const previousEnd = extensionCurrentEnd({ residentEnd: applicant.manualResidentDetails?.moveOutDate || applicant.application?.leaseEnd, leaseEnd: lease.application?.leaseEnd, bookingEnds: occupancy.entries.filter((e) => own(e) && !e.openEnded).map((e) => e.end) });
  const first = stayDatePlus(previousEnd, 1), newEnd = stayDatePlus(checkout, -1);
  if (checkout <= first) throw new StayExtensionError("Choose a checkout date after the current checkout.", 400);
  const conflict = occupancy.entries.find((e) => !own(e) && (e.roomId === roomId || !e.roomId || e.roomId === propertyId) && e.start <= newEnd && e.end >= first);
  if (conflict) throw new StayExtensionError(`Cannot extend: ${conflict.guestName || conflict.residentName || conflict.summary || "another booking"} holds ${conflict.roomLabel || "this room"}, ${conflict.start}–${stayDatePlus(conflict.end, 1)}.`);
  const app = { ...applicant.application, ...lease.application, leaseStart: applicant.manualResidentDetails?.moveInDate || applicant.application?.leaseStart || lease.application?.leaseStart || first, leaseEnd: newEnd, signedMonthlyRent: applicant.signedMonthlyRent };
  const pricingSubmission = submissionWithApplicationRoomFees(submission, {
    roomChoices: [choice], signedMonthlyRent: applicant.signedMonthlyRent,
  }, { leaseTerm: app.leaseTerm, rentalType: app.rentalType, applicationTemplateId: app.applicationTemplateId, listingProperty: property });
  const profile = profilesResult.data[0]?.row_data;
  const utilities = app.managerUtilitiesOverride?.trim() ? parseMoneyAmount(app.managerUtilitiesOverride) : profile?.monthlyUtilities ?? applicant.manualResidentDetails?.monthlyUtilities ?? (applicant.manuallyAdded ? 0 : utilitiesBillableMonthlyAmount(submission, room));
  const negotiated = parseMoneyAmount(app.managerRentOverride ?? "") > 0 || Number(app.signedMonthlyRent) > 0;
  const rawLines = priceStayExtension({ currentEnd: previousEnd, checkout, pricing: { room, submission: pricingSubmission, application: app }, monthlyUtilities: utilities,
    monthlyFoldIn: negotiated ? 0 : monthlyRentFoldInTotal(pricingSubmission, property, app), fees: monthlyFeesBilledSeparately(pricingSubmission, property, app) });
  const existingCharges = chargesResult.data.map((r) => r.row_data as ExtensionCharge);
  let lines: ExtensionLine[];
  try { lines = creditPrebilledExtension(rawLines, existingCharges, previousEnd); }
  catch (error) { throw new StayExtensionError(error instanceof Error ? error.message : "Review existing charges before extending."); }
  const createdAt = new Date().toISOString();
  const charges: ExtensionCharge[] = lines.filter((line) => line.amountCents > 0).map((line, i) => ({
    id: `hc_${id}_${i}`, createdAt, applicationId: appId, residentEmail: record.resident_email.toLowerCase(), residentName: lease.residentName,
    residentUserId: lease.residentUserId ?? applicant.residentUserId ?? null, managerUserId: owner, propertyId, propertyLabel: property.title,
    roomLabel: room.name, kind: line.kind === "rent" && existingCharges.some((c) => c.kind === "rent" && c.rentMonth === line.month && !["void", "refunded", "cancelled"].includes(c.status)) ? "prorated_rent" : line.kind,
    title: `Stay extension · ${line.label}`, amountLabel: `$${(line.amountCents / 100).toFixed(2)}`, balanceLabel: `$${(line.amountCents / 100).toFixed(2)}`,
    status: "pending", blocksLeaseUntilPaid: false, dueAtSigning: false, dueDateLabel: line.start, rentMonth: line.month,
    residentVisibleAt: createdAt,
    manualAmountOverrideAt: createdAt, customFeeId: line.kind === "other_cost" || line.kind === "rent" ? `extension:${id}:${line.key}` : undefined,
    stayExtension: { extensionId: id, key: line.key, start: line.start, end: line.end },
  }));
  const extension: StayExtension = { id, leaseId, previousEnd, newEnd, checkout, createdAt, actorId, lines, totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0), chargeIds: charges.map((c) => c.id) };
  const revisionCheck = await db.from("manager_property_records").select("occupancy_revision").eq("id", propertyId).single();
  if (revisionCheck.error || revisionCheck.data.occupancy_revision !== houseResult.data.occupancy_revision) throw new StayExtensionError("Availability changed. Review the extension again.");
  const token = hash([leaseId, checkout, houseResult.data.occupancy_revision, appResult.data, lease, chargesResult.data, lines]);
  return { record, extension, token, charges, expectedCharges: chargesResult.data, applicationRecord: appResult.data, revision: houseResult.data.occupancy_revision };
}

export async function completeStayExtension(db: SupabaseClient, record: Awaited<ReturnType<typeof authorizeStayExtension>>, extension: StayExtension, actor: { id: string; email?: string }) {
  if (extension.chargeIds.length) {
    const rows = await db.from("portal_household_charge_records").select("row_data").eq("manager_user_id", record.manager_user_id).in("id", extension.chargeIds);
    if (rows.error || rows.data.length !== extension.chargeIds.length) throw new Error("Extension saved; billing reconciliation needs a retry.");
    for (const charge of rows.data) await syncLedgerChargeEntry(db, charge.row_data);
  }
  const text = `Your stay at ${record.row_data.unit || "your home"} is extended. New checkout: ${extension.checkout}. Added charges: $${(extension.totalCents / 100).toFixed(2)}. Deposit unchanged.\n${extension.lines.map((l) => `${l.label}: $${(l.amountCents / 100).toFixed(2)}`).join("\n")}\nView your charges in PropLane: ${residentPortalUrl("payments")}`;
  const result = await emitActionEvent(db, { eventId: extension.id, domain: "lease", event: "stay_extended", managerUserId: record.manager_user_id, entityId: record.id, category: "leases", senderUserId: actor.id, senderEmail: actor.email || "", channel: await residentNoticeChannel(db, { managerUserId: record.manager_user_id, email: record.resident_email }), payload: { propertyId: record.property_id, extensionId: extension.id, checkout: extension.checkout, totalCents: extension.totalCents }, recipients: [{ audience: "resident", userId: record.row_data.residentUserId ?? undefined, email: record.resident_email, rendered: { subject: "Your stay has been extended", text } }] });
  if (result.duplicate) {
    // The event bus counts attempts made in this call only. A duplicate does not
    // mean the earlier delivery succeeded; its durable retry owns that attempt.
    const event = await db.from("action_events").select("id").eq("event_key", extension.id).eq("manager_user_id", record.manager_user_id).single();
    if (event.error || !event.data) throw new Error("Could not verify the resident notice.");
    const deliveries = await db.from("action_event_deliveries").select("status").eq("event_id", event.data.id).eq("audience", "resident");
    if (deliveries.error) throw new Error("Could not verify the resident notice.");
    return { ...result, failed: deliveries.data.filter((row) => /failed/.test(row.status)).length,
      deferred: deliveries.data.filter((row) => row.status === "deferred" || row.status === "pending").length };
  }
  return result;
}
