import { formatPacificDate } from "@/lib/pacific-time";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication } from "@/lib/generated-lease";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
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
  leaseRecord: { property_id?: string | null; manager_user_id?: string | null },
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
  let roomName = "";
  if (propRecord) {
    const pd = asObject(propRecord.property_data);
    if (pd?.listingSubmission) {
      const rawSub = pd.listingSubmission as ManagerListingSubmissionV1;
      if (rawSub.v === 1) {
        const norm = normalizeManagerListingSubmissionV1(rawSub);
        const room = norm.rooms.find((r) => r.id === roomId);
        if (room) {
          roomCapacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
          roomName = room.name.trim().toLowerCase();
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

  // Approved placements reserve beds even before either lease signature exists.
  // Exclude this application only: the same resident may have another stay.
  const peers: { id: string; placement: RoomOccupancyPlacement; start: string; end: string | null }[] = [];
  // Same key `room_placement_application_key` matches on in SQL: a raw comparison
  // misses a legacy id form, and for a lease with no `axisId` it compares against
  // the literal "UNDEFINED" — which counts the resident's own placement as a
  // roommate and reports a capacity-1 room as full.
  const selfKey = normalizeApplicationAxisId(asString(leaseRow.axisId)).toUpperCase();
  // Without an `axisId` there is no id to match on, so the resident's own placement
  // is identified by owner + property + room + email — and only when exactly ONE
  // such placement exists. Several same-email stays in one room are ambiguous, and
  // dropping them all would hand the resident a bed somebody else holds.
  const selfEmail = (asString(excludeResidentEmail) || asString(leaseRow.residentEmail)).toLowerCase();
  const emailSelfCandidates = new Set<string>();
  const owner = String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? "");
  for (let offset = 0; ; offset += 500) {
    const { data: applications, error } = await db.from("manager_application_records")
      .select("id,row_data,occupancy_start,resident_email").eq("manager_user_id", owner).eq("row_data->>bucket", "approved")
      .order("id").range(offset, offset + 499);
    if (error) return { ok: false, direction, reason: "Could not verify room availability. Please try again." };
    for (const rec of applications ?? []) {
      const row = asObject(rec.row_data);
      if (!row || row.withdrawnAt || (selfKey && normalizeApplicationAxisId(String(rec.id)).toUpperCase() === selfKey)) continue;
      const app = asObject(row.application) ?? {}, manual = asObject(row.manualResidentDetails) ?? {};
      const assignedProperty = asString(row.assignedPropertyId) || asString(row.propertyId) || asString(app.propertyId);
      if (assignedProperty !== propertyId) continue;
      const choice = asString(row.assignedRoomChoice) || asString(app.roomChoice1);
      if (choice !== (leaseRow.roomChoice ?? leaseRow.application?.roomChoice1) && choice !== propertyId && choice !== roomId && !(roomName && !choice.includes("::") && String(manual.roomNumber || choice).trim().toLowerCase() === roomName)) continue;
      const currentPlacementStart = asString(manual.moveInDate) || asString(app.leaseStart) || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
      const start = rec.occupancy_start && rec.occupancy_start < currentPlacementStart ? rec.occupancy_start : currentPlacementStart;
      const end = asString(manual.moveOutDate) || asString(app.leaseEnd);
      const parse = (value: string) => {
        const parts = value.includes("/") ? value.split("/").map(Number) : null;
        return parts ? new Date(parts[2], parts[0] - 1, parts[1]) : ymdToLocalDate(value);
      };
      const startDate = parse(start);
      if (!startDate) return { ok: false, direction, reason: "A placement has an invalid date. Update it before extending this lease." };
      if (!selfKey && selfEmail && asString(rec.resident_email).toLowerCase() === selfEmail) emailSelfCandidates.add(String(rec.id));
      for (let bed = 0; bed < (choice === propertyId ? roomCapacity : 1); bed++) peers.push({ id: String(rec.id), placement: { id: `${rec.id}:${bed}`, start: startDate, end: end ? parse(end) : null }, start, end: end || null });
    }
    if ((applications ?? []).length < 500) break;
  }
  const selfRecordId = !selfKey && emailSelfCandidates.size === 1 ? [...emailSelfCandidates][0] : null;
  const roommates = selfRecordId ? peers.filter((peer) => peer.id !== selfRecordId) : peers;

  const windowStart = ymdToLocalDate(extensionStart);
  const windowEnd = ymdToLocalDate(newLeaseEnd);
  if (!windowStart || !windowEnd) return { ok: true, direction };

  // A roommate no longer blocks an extension while a bed is genuinely free: the
  // room refuses only once its peers alone reach capacity.
  const occupancy = evaluateRoomOccupancy({
    capacity: roomCapacity,
    placements: roommates.map((peer) => peer.placement),
    windowStart,
    windowEnd,
  });
  if (occupancy.hasRoom) return { ok: true, direction };

  if (audience === "manager") {
    const blocker = roommates
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

export async function regenerateLeaseHtmlForApplication(
  db: SupabaseClient,
  leaseRecord: { property_id?: string | null; manager_user_id?: string | null },
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

  const ownerId = String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? "");
  const { data: applicationRecord, error: applicationError } = await db.from("manager_application_records")
    .select("id,row_data").eq("id", leaseRow.axisId).eq("manager_user_id", ownerId).maybeSingle();
  if (applicationError || !applicationRecord) return { ok: false, error: "The residency could not be loaded. Refresh before changing dates." };
  const { error: commitError } = await db.rpc("commit_room_lease_extension", {
    p_owner: ownerId, p_application_id: applicationRecord.id, p_expected_application: applicationRecord.row_data,
    p_lease_id: leaseRecord.id, p_expected_lease: leaseRecord.row_data, p_next_lease: updatedRow, p_end: newLeaseEnd,
  });
  if (commitError) return { ok: false, error: commitError.code === "P4001" ? "No bed is available in this room for the requested dates." : "The lease changed or could not be saved. Refresh and retry." };

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
              (r.id === roomId && (r.occupancyCapacity ?? 1) === 1)
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
