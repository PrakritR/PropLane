import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { formatPacificDate } from "@/lib/pacific-time";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication } from "@/lib/generated-lease";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  evaluateRoomOccupancy,
  normalizeRoomOccupancyCapacity,
  type RoomOccupancyPlacement,
} from "@/lib/rental-application/room-occupancy";
import type { LeasePipelineRow, SignedLeaseSnapshot } from "@/lib/lease-pipeline-storage";
import { renewalRentalTypeForTerm } from "@/lib/lease-renewal-terms";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1, ManagerRoomUnavailableRange } from "@/lib/manager-listing-submission";
import type { SupabaseClient } from "@supabase/supabase-js";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function hasBothLeaseSignatures(row: LeasePipelineRow): boolean {
  const mgr = row.managerSignature as Record<string, unknown> | null | undefined;
  const res = row.residentSignature as Record<string, unknown> | null | undefined;
  const legacyName = typeof row.signatureName === "string" ? row.signatureName : null;
  const legacyAt = typeof row.signedAtIso === "string" ? row.signedAtIso : null;
  return Boolean(mgr?.name && mgr?.signedAtIso && ((res?.name && res?.signedAtIso) || (legacyName && legacyAt)));
}

function archiveSignedLeaseSnapshot(leaseRow: LeasePipelineRow): SignedLeaseSnapshot[] {
  if (!hasBothLeaseSignatures(leaseRow)) return leaseRow.signedLeaseSnapshots ?? [];
  const signedAt = leaseRow.fullySignedAt ?? leaseRow.updatedAtIso ?? new Date().toISOString();
  const term = leaseRow.application?.leaseTerm ?? "";
  const end = leaseRow.application?.leaseEnd ?? "";
  const snapshot: SignedLeaseSnapshot = {
    id: `snap-${Date.now().toString(36)}`,
    label: `Prior lease${term ? ` · ${term}` : ""}${end ? ` · ends ${end}` : ""}`,
    fullySignedAt: signedAt,
    leaseTerm: term || undefined,
    leaseStart: leaseRow.application?.leaseStart,
    leaseEnd: end || undefined,
    generatedHtml: leaseRow.generatedHtml ?? null,
    managerUploadedPdf: leaseRow.managerUploadedPdf ?? null,
    archivedAtIso: new Date().toISOString(),
  };
  return [...(leaseRow.signedLeaseSnapshots ?? []), snapshot];
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function propertyFromRecord(record: { id: string; property_data: unknown; row_data: unknown }): MockProperty | undefined {
  const pd = asObject(record.property_data);
  if (pd) {
    const id = asString(pd.id) || record.id;
    return {
      id,
      title: asString(pd.title) || asString(pd.buildingName) || "Property",
      tagline: asString(pd.tagline),
      address: asString(pd.address),
      zip: asString(pd.zip),
      neighborhood: asString(pd.neighborhood),
      beds: typeof pd.beds === "number" ? pd.beds : 0,
      baths: typeof pd.baths === "number" ? pd.baths : 0,
      rentLabel: asString(pd.rentLabel),
      available: asString(pd.available),
      petFriendly: Boolean(pd.petFriendly),
      buildingId: asString(pd.buildingId) || id,
      buildingName: asString(pd.buildingName) || asString(pd.title) || "Property",
      unitLabel: asString(pd.unitLabel),
      listingSubmission: pd.listingSubmission as MockProperty["listingSubmission"],
      managerUserId: asString(pd.managerUserId) || undefined,
      adminPublishLive: Boolean(pd.adminPublishLive),
    };
  }
  const rd = asObject(record.row_data);
  if (!rd) return undefined;
  const sub = asObject(rd.submission);
  const buildingName = asString(rd.buildingName) || asString(sub?.buildingName) || "Property";
  return {
    id: record.id,
    title: buildingName,
    tagline: asString(rd.tagline),
    address: asString(rd.address) || asString(sub?.address),
    zip: asString(rd.zip) || asString(sub?.zip),
    neighborhood: asString(rd.neighborhood),
    beds: typeof rd.beds === "number" ? rd.beds : 0,
    baths: typeof rd.baths === "number" ? rd.baths : 0,
    rentLabel: "",
    available: "",
    petFriendly: Boolean(rd.petFriendly),
    buildingId: record.id,
    buildingName,
    unitLabel: asString(rd.unitLabel),
    listingSubmission: sub as MockProperty["listingSubmission"],
    managerUserId: undefined,
    adminPublishLive: false,
  };
}

function formatAvailabilityLabel(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3) return `Available from ${isoDate}`;
  const [y, m, d] = parts as [number, number, number];
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return `Available from ${isoDate}`;
  return `Available from ${formatPacificDate(dt, { year: "numeric", month: "long", day: "numeric" })}`;
}

/**
 * Who is asking. A manager owns the property and may be told which resident holds
 * the room and until when; a resident may not learn anything about a roommate.
 * Defaults to "resident" so a new caller discloses the LESS, not the more.
 */
export type MoveOutAvailabilityAudience = "manager" | "resident";

/** "YYYY-MM-DD" to local midnight, matching how room occupancy dates are compared. */
function ymdToLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export async function checkMoveOutAvailabilityForLease(
  db: SupabaseClient,
  leaseRow: LeasePipelineRow,
  leaseRecord: { property_id?: string | null },
  newLeaseEnd: string,
  excludeResidentEmail?: string,
  audience: MoveOutAvailabilityAudience = "resident",
): Promise<
  | { ok: true; direction: "extend" | "decrease" | "same" }
  | { ok: false; direction: "extend" | "decrease" | "same"; reason: string; nextAvailableDate?: string | null }
> {
  const currentEnd = leaseRow.application?.leaseEnd ?? "";
  const currentStart = leaseRow.application?.leaseStart ?? "";
  const direction =
    newLeaseEnd < currentEnd ? "decrease" : newLeaseEnd > currentEnd ? "extend" : ("same" as const);

  if (direction === "decrease") {
    if (currentStart && newLeaseEnd < currentStart) {
      return { ok: false, direction, reason: "New move-out date cannot be before the lease start date." };
    }
    return { ok: true, direction };
  }
  if (direction === "same") return { ok: true, direction };

  const extensionStart = (() => {
    const d = new Date(currentEnd + "T00:00:00");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const roomChoice = leaseRow.roomChoice ?? leaseRow.application?.roomChoice1 ?? "";
  const sep = "::";
  const sepIdx = roomChoice.indexOf(sep);
  const roomId = sepIdx >= 0 ? roomChoice.slice(sepIdx + sep.length) : null;
  const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? "";

  if (!propertyId || !roomId) return { ok: true, direction };

  const { data: propRecord } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();

  let roomCapacity = 1;
  if (propRecord) {
    const pd = asObject(propRecord.property_data);
    if (pd?.listingSubmission) {
      const rawSub = pd.listingSubmission as ManagerListingSubmissionV1;
      if (rawSub.v === 1) {
        const norm = normalizeManagerListingSubmissionV1(rawSub);
        const room = norm.rooms.find((r) => r.id === roomId);
        if (room) {
          roomCapacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
          // A manager-set block closes the room outright, whatever its capacity,
          // and is the manager's OWN data — safe to describe to either audience.
          const blocked = (room.manualUnavailableRanges ?? []).find((range: ManagerRoomUnavailableRange) =>
            rangesOverlap(extensionStart, newLeaseEnd, range.start, range.end),
          );
          if (blocked) {
            return {
              ok: false,
              direction,
              reason: `This room has a blocked period from ${blocked.start} to ${blocked.end}.`,
              nextAvailableDate: blocked.end,
            };
          }
        }
      }
    }
  }

  const email = excludeResidentEmail?.trim().toLowerCase() ?? leaseRow.residentEmail.trim().toLowerCase();
  const { data: otherLeases } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data, resident_email")
    .eq("property_id", propertyId)
    .neq("resident_email", email)
    .order("updated_at", { ascending: false });

  // Peers are reduced to anonymous date intervals immediately. Their names, rent
  // and lease documents are in row_data and must not travel any further than this
  // loop — under per-bed rentals a roommate reaches this code path routinely.
  const peers: { placement: RoomOccupancyPlacement; start: string; end: string | null }[] = [];
  for (const rec of otherLeases ?? []) {
    const row = asObject(rec.row_data) as unknown as LeasePipelineRow | null;
    if (!row || !hasBothLeaseSignatures(row) || row.status === "Voided") continue;
    const otherRoomChoice = row.roomChoice ?? row.application?.roomChoice1 ?? "";
    const otherSepIdx = otherRoomChoice.indexOf(sep);
    const otherRoomId = otherSepIdx >= 0 ? otherRoomChoice.slice(otherSepIdx + sep.length) : null;
    if (otherRoomId !== roomId) continue;
    const otherStart = asString(row.application?.leaseStart);
    const otherEnd = asString(row.application?.leaseEnd);
    if (!otherStart) continue;
    const startDate = ymdToLocalDate(otherStart);
    if (!startDate) continue;
    peers.push({
      placement: { id: String(rec.id ?? otherStart), start: startDate, end: otherEnd ? ymdToLocalDate(otherEnd) : null },
      start: otherStart,
      end: otherEnd || null,
    });
  }

  const windowStart = ymdToLocalDate(extensionStart);
  const windowEnd = ymdToLocalDate(newLeaseEnd);
  if (!windowStart || !windowEnd) return { ok: true, direction };

  // A roommate no longer blocks an extension while a bed is genuinely free: the
  // room refuses only once its peers alone reach capacity.
  const occupancy = evaluateRoomOccupancy({
    capacity: roomCapacity,
    placements: peers.map((peer) => peer.placement),
    windowStart,
    windowEnd,
  });
  if (occupancy.hasRoom) return { ok: true, direction };

  if (audience === "manager") {
    const blocker = peers
      .filter((peer) => rangesOverlap(extensionStart, newLeaseEnd, peer.start, peer.end || "9999-12-31"))
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    if (blocker) {
      return {
        ok: false,
        direction,
        reason: `This room is already booked by another resident starting ${blocker.start}.`,
        nextAvailableDate: blocker.end,
      };
    }
  }

  // Resident-facing refusal. Deliberately says nothing about who holds the room or
  // until when: the caller controls newLeaseEnd, so any peer date returned here can
  // be binary-searched out of the endpoint. A bare yes/no still reveals aggregate
  // availability, which is unavoidable for a booking check.
  return {
    ok: false,
    direction,
    reason: "No bed is available in this room for the requested dates.",
    nextAvailableDate: null,
  };
}

async function syncApplicationLeaseDates(
  db: SupabaseClient,
  axisId: string | null | undefined,
  newLeaseEnd: string,
  iso: string,
  managerUserId: string,
): Promise<void> {
  const id = axisId?.trim();
  if (!id || !managerUserId) return;
  const { data: appRecord } = await db.from("manager_application_records").select("id, manager_user_id, row_data").eq("id", id).eq("manager_user_id", managerUserId).maybeSingle();
  if (!appRecord?.row_data || typeof appRecord.row_data !== "object") return;
  const rowData = appRecord.row_data as Record<string, unknown>;
  const application = asObject(rowData.application) ?? {};
  const manual = asObject(rowData.manualResidentDetails) ?? {};
  await db
    .from("manager_application_records")
    .update({
      row_data: sealApplicantRow({
        ...rowData,
        application: { ...application, leaseEnd: newLeaseEnd },
        manualResidentDetails: { ...manual, moveOutDate: newLeaseEnd },
      }, id, managerUserId),
      updated_at: iso,
    })
    .eq("id", id)
    .eq("manager_user_id", managerUserId);
}

export async function regenerateLeaseHtmlForApplication(
  db: SupabaseClient,
  leaseRecord: { property_id?: string | null },
  leaseRow: LeasePipelineRow,
  updatedApplication: NonNullable<LeasePipelineRow["application"]>,
): Promise<{ html: string; executedJurisdiction: string | null; templateVersion: string | null } | null> {
  try {
    const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? "";
    const propertyRecord = propertyId
      ? (await db.from("manager_property_records").select("id, property_data, row_data").eq("id", propertyId).maybeSingle()).data
      : null;
    if (!propertyRecord) return null;
    const prop = propertyFromRecord(propertyRecord as { id: string; property_data: unknown; row_data: unknown });
    if (!prop) return null;
    const ctx = leaseContextFromApplication({ ...updatedApplication, propertyId });
    const finalCtx = ctx.submission
      ? ctx
      : {
          ...ctx,
          leasedRoom: prop,
          listingProperty: prop,
          submission:
            prop.listingSubmission?.v === 1
              ? normalizeManagerListingSubmissionV1(prop.listingSubmission as ManagerListingSubmissionV1)
              : ctx.submission,
        };
    const outcome = buildAiGeneratedLeaseHtml(finalCtx);
    if (outcome.kind !== "generated") return null;
    return {
      html: outcome.html,
      executedJurisdiction: outcome.executedJurisdiction,
      templateVersion: outcome.templateVersion,
    };
  } catch {
    return null; /* best-effort */
  }
}

export async function amendLeaseMoveOutDate(
  db: SupabaseClient,
  leaseRecord: {
    id: string;
    manager_user_id?: string | null;
    property_id?: string | null;
    row_data: unknown;
  },
  newLeaseEnd: string,
): Promise<{ ok: true; direction: "extend" | "decrease"; newLeaseEnd: string } | { ok: false; error: string }> {
  const leaseRow = leaseRecord.row_data as LeasePipelineRow;
  if (!hasBothLeaseSignatures(leaseRow) || leaseRow.status === "Voided") {
    return { ok: false, error: "Only fully signed leases can be renewed or extended." };
  }

  const currentStart = leaseRow.application?.leaseStart ?? "";
  if (currentStart && newLeaseEnd < currentStart) {
    return { ok: false, error: "New move-out date cannot be before the lease start date." };
  }
  const currentEnd = leaseRow.application?.leaseEnd ?? "";
  if (newLeaseEnd === currentEnd) {
    return { ok: false, error: "New move-out date is the same as the current date." };
  }

  const availability = await checkMoveOutAvailabilityForLease(db, leaseRow, leaseRecord, newLeaseEnd);
  if (!availability.ok) {
    return { ok: false, error: availability.reason };
  }

  const updatedApplication = { ...(leaseRow.application ?? {}), leaseEnd: newLeaseEnd };
  const iso = new Date().toISOString();
  const regeneratedDocument = await regenerateLeaseHtmlForApplication(db, leaseRecord, leaseRow, updatedApplication);
  const signedLeaseSnapshots = archiveSignedLeaseSnapshot(leaseRow);

  const updatedRow: Partial<LeasePipelineRow> = {
    ...leaseRow,
    application: updatedApplication,
    signedLeaseSnapshots,
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    bucket: "manager",
    status: "Manager Review",
    currentActorRole: "manager",
    updatedAtIso: iso,
    updated: "just now",
    ...(regeneratedDocument
      ? {
          generatedHtml: regeneratedDocument.html,
          generatedAtIso: iso,
          executedJurisdiction: regeneratedDocument.executedJurisdiction,
          templateVersion: regeneratedDocument.templateVersion,
        }
      : {}),
  };

  const { error: upsertError } = await db.from("portal_lease_pipeline_records").upsert({
    id: leaseRecord.id,
    manager_user_id: leaseRecord.manager_user_id,
    resident_user_id: leaseRow.residentUserId ?? null,
    resident_email: leaseRow.residentEmail.trim().toLowerCase(),
    property_id: leaseRecord.property_id ?? null,
    status: "manager",
    row_data: updatedRow,
    updated_at: iso,
  });
  if (upsertError) return { ok: false, error: upsertError.message };

  await syncApplicationLeaseDates(db, leaseRow.axisId, newLeaseEnd, iso, String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? ""));

  try {
    const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? "";
    const roomChoice = leaseRow.roomChoice ?? leaseRow.application?.roomChoice1 ?? "";
    const sep = "::";
    const sepIdx = roomChoice.indexOf(sep);
    const roomId = sepIdx >= 0 ? roomChoice.slice(sepIdx + sep.length) : null;
    if (propertyId && roomId) {
      const { data: propRecord } = await db
        .from("manager_property_records")
        .select("id, property_data, row_data")
        .eq("id", propertyId)
        .maybeSingle();
      if (propRecord) {
        const pd = asObject(propRecord.property_data);
        if (pd?.listingSubmission) {
          const sub = pd.listingSubmission as ManagerListingSubmissionV1;
          if (sub.v === 1) {
            const norm = normalizeManagerListingSubmissionV1(sub);
            const updatedRooms = norm.rooms.map((r) =>
              r.id === roomId
                ? { ...r, moveInAvailableDate: newLeaseEnd, availability: formatAvailabilityLabel(newLeaseEnd) }
                : r,
            );
            await db
              .from("manager_property_records")
              .update({ property_data: { ...pd, listingSubmission: { ...norm, rooms: updatedRooms } }, updated_at: iso })
              .eq("id", propertyId);
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }

  const direction = newLeaseEnd < currentEnd ? "decrease" : "extend";
  return { ok: true, direction, newLeaseEnd };
}

export type LeaseRenewalTerms = {
  leaseTerm: string;
  leaseStart: string;
  /** Empty string means Month-to-Month (no end date). */
  leaseEnd: string;
  monthlyRent: number | null;
  rentalType?: "standard" | "short_term";
};

/**
 * Full renewal: new term (fixed length or Month-to-Month), start date, and
 * optionally a new rent. Like the move-out amendment, the lease re-enters the
 * pipeline at Manager Review with signatures cleared and its document
 * regenerated — but the application record and payment schedule are NOT
 * touched here. The renewal terms are stashed on the row (`pendingRenewal`)
 * and applied to the application + rent profile + charges only when both
 * parties have signed the renewed lease (see applySignedLeaseRenewal on the
 * client), so payments always reflect the SIGNED lease, never a draft.
 */
export async function renewLease(
  db: SupabaseClient,
  leaseRecord: {
    id: string;
    manager_user_id?: string | null;
    property_id?: string | null;
    row_data: unknown;
  },
  terms: LeaseRenewalTerms,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const leaseRow = leaseRecord.row_data as LeasePipelineRow;
  if (!hasBothLeaseSignatures(leaseRow) || leaseRow.status === "Voided") {
    return { ok: false, error: "Only fully signed leases can be renewed." };
  }

  const rentalType = terms.rentalType ?? renewalRentalTypeForTerm(terms.leaseTerm);
  const isShortTerm = rentalType === "short_term";
  const isMonthToMonth = !isShortTerm && terms.leaseTerm === "Month-to-Month";
  if (!terms.leaseStart) return { ok: false, error: "Renewal start date is required." };
  if (isShortTerm && !terms.leaseEnd) {
    return { ok: false, error: "Check-out date is required for a short-term renewal." };
  }
  if (!isMonthToMonth && !isShortTerm && !terms.leaseEnd) {
    return { ok: false, error: "Renewal end date is required." };
  }
  if (terms.leaseEnd && terms.leaseEnd < terms.leaseStart) {
    return { ok: false, error: "Renewal end date cannot be before the start date." };
  }
  if (terms.monthlyRent != null && (!Number.isFinite(terms.monthlyRent) || terms.monthlyRent <= 0)) {
    return { ok: false, error: isShortTerm ? "Nightly rate must be a positive amount." : "Monthly rent must be a positive amount." };
  }

  // Room must stay free through the renewal period (open-ended for M2M).
  const effectiveEnd = isMonthToMonth ? "9999-12-31" : terms.leaseEnd;
  const availability = await checkMoveOutAvailabilityForLease(db, leaseRow, leaseRecord, effectiveEnd);
  if (!availability.ok) return { ok: false, error: availability.reason };

  const iso = new Date().toISOString();
  const canonicalTerm = isShortTerm ? SHORT_TERM_LEASE_TERM : terms.leaseTerm;
  const rentLabel =
    terms.monthlyRent != null
      ? isShortTerm
        ? `$${terms.monthlyRent.toFixed(2)} / night`
        : `$${terms.monthlyRent.toFixed(2)} / month`
      : null;
  const updatedApplication: NonNullable<LeasePipelineRow["application"]> = {
    ...(leaseRow.application ?? {}),
    rentalType,
    leaseTerm: canonicalTerm,
    leaseStart: terms.leaseStart,
    leaseEnd: isMonthToMonth ? "" : terms.leaseEnd,
    ...(terms.monthlyRent != null ? { managerRentOverride: String(terms.monthlyRent) } : {}),
  };
  if (rentLabel) {
    // The generated document reads rent from this snapshot (rentSummaryFromApplication).
    (updatedApplication as Record<string, unknown>).__signedRentLabel = rentLabel;
  }

  const regeneratedDocument = await regenerateLeaseHtmlForApplication(db, leaseRecord, leaseRow, updatedApplication);
  const signedLeaseSnapshots = archiveSignedLeaseSnapshot(leaseRow);

  const updatedRow: Partial<LeasePipelineRow> = {
    ...leaseRow,
    application: updatedApplication,
    ...(rentLabel ? { signedRentLabel: rentLabel } : {}),
    pendingRenewal: { ...terms, leaseTerm: canonicalTerm, rentalType, requestedAtIso: iso },
    signedLeaseSnapshots,
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    bucket: "manager",
    status: "Manager Review",
    currentActorRole: "manager",
    updatedAtIso: iso,
    updated: "just now",
    ...(regeneratedDocument
      ? {
          generatedHtml: regeneratedDocument.html,
          generatedAtIso: iso,
          executedJurisdiction: regeneratedDocument.executedJurisdiction,
          templateVersion: regeneratedDocument.templateVersion,
        }
      : {}),
  };

  const { error: upsertError } = await db.from("portal_lease_pipeline_records").upsert({
    id: leaseRecord.id,
    manager_user_id: leaseRecord.manager_user_id,
    resident_user_id: leaseRow.residentUserId ?? null,
    resident_email: leaseRow.residentEmail.trim().toLowerCase(),
    property_id: leaseRecord.property_id ?? null,
    status: "manager",
    row_data: updatedRow,
    updated_at: iso,
  });
  if (upsertError) return { ok: false, error: upsertError.message };

  return { ok: true };
}
