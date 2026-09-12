import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { normalizeE164 } from "@/lib/twilio";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";
import { resolveTourSmsEligibility } from "@/lib/sms/tour-sms-eligibility.server";

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
export const TOUR_INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

function rowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as { payload?: unknown }).payload;
  return Array.isArray(payload)
    ? payload.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function phone(raw: string): string {
  return normalizeE164Us(raw) ?? normalizeE164(raw) ?? "";
}

type ProposalStatus = "awaiting_reply" | "confirmed" | "needs_manager_follow_up";
type Proposal = {
  version: string;
  generation?: string;
  proposedStart: string;
  proposedEnd: string;
  requestedAt: string;
  status: ProposalStatus;
  phoneE164: string;
  workNumber: string;
  conversationKey: string;
  /** Server-derived at notification time. Never copied from legacy form state. */
  smsEligibility?: "eligible";
  smsConsentProvenance?: "tour_inquiry_opt_in" | "recipient_initiated_inbound" | "twilio_start";
  confirmedAt?: string;
  followUpRequestedAt?: string;
  replyText?: string;
  inboundMessageSid?: string;
};

/**
 * A pre-PRP-473 proposal has no server-derived eligibility marker. Repair is
 * an upgrade of the exact row the inbound read selected, never a request to
 * create the proposal again. Keep every discriminator here because the CAS
 * may reread after another delivery has replaced the proposal.
 */
type LegacyProposalSnapshot = {
  eventId: string;
  sourceInquiryId: string;
  managerUserId: string;
  phoneE164: string;
  workNumber: string;
  proposedStart: string;
  proposedEnd: string;
  rowGeneration: string;
  proposalVersion: string;
  proposalGeneration: string;
  proposalStatus: ProposalStatus;
  conversationKey: string;
  requestedAt: string;
  smsOrigin: unknown;
  smsConsent: unknown;
};

type LegacyRepairGuard = {
  recordId: string;
  snapshot: LegacyProposalSnapshot;
};

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? String(row[key]).trim() : "";
}

function proposal(row: Record<string, unknown>): Proposal | null {
  const value = row.guestRescheduleReply;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Proposal;
}

/**
 * Historical proposals legitimately predate transition generations. Treat only
 * the pair with no persisted generation and no proposal generation as legacy;
 * a present generation must agree exactly rather than silently falling back to
 * a phone-number version.
 */
function generationsAgree(proposalGeneration: string | undefined, rowGeneration: string): boolean {
  return (proposalGeneration?.trim() ?? "") === rowGeneration;
}

function inputGenerationMatchesRow(inputGeneration: string | undefined, rowGeneration: string): boolean {
  return (inputGeneration?.trim() ?? "") === rowGeneration;
}

function legacySnapshotMatches(
  event: Record<string, unknown>,
  existing: Proposal | null,
  snapshot: LegacyProposalSnapshot,
): boolean {
  if (!existing) return false;
  return text(event, "id") === snapshot.eventId &&
    text(event, "sourceInquiryId") === snapshot.sourceInquiryId &&
    text(event, "managerUserId") === snapshot.managerUserId &&
    text(event, "rescheduleNotificationGeneration") === snapshot.rowGeneration &&
    Object.is(event.smsOrigin, snapshot.smsOrigin) && Object.is(event.smsConsent, snapshot.smsConsent) &&
    existing.phoneE164 === snapshot.phoneE164 && existing.workNumber === snapshot.workNumber &&
    existing.proposedStart === snapshot.proposedStart && existing.proposedEnd === snapshot.proposedEnd &&
    existing.version === snapshot.proposalVersion && (existing.generation?.trim() ?? "") === snapshot.proposalGeneration &&
    existing.status === snapshot.proposalStatus && existing.conversationKey === snapshot.conversationKey &&
    existing.requestedAt === snapshot.requestedAt && existing.smsEligibility === undefined &&
    generationsAgree(existing.generation, snapshot.rowGeneration);
}

function upgradedLegacySnapshotMatches(
  event: Record<string, unknown>,
  existing: Proposal | null,
  snapshot: LegacyProposalSnapshot,
): boolean {
  if (!existing || existing.smsEligibility !== "eligible") return false;
  const legacyShape = { ...existing, smsEligibility: undefined } satisfies Proposal;
  return legacySnapshotMatches(event, legacyShape, snapshot);
}

function versionFor(eventId: string, start: string, end: string, phoneE164: string, workNumber: string): string {
  // The expected reply is tied to the exact inbound phone pair. A work-number
  // rotation must create a new generation instead of silently accepting an old
  // proposal whose replies arrive at a number we no longer own.
  return `${eventId}:${start}:${end}:${phoneE164}:${workNumber}`;
}

export function nextTourScheduleCasTimestamp(previous: string, nowMs = Date.now()): string | null {
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(previousMs)) return null;
  return new Date(Math.max(nowMs, previousMs + 1)).toISOString();
}

async function ownerWorkNumber(db: SupabaseClient, managerUserId: string): Promise<string> {
  return phone(await resolveActiveManagerSendNumber(db, managerUserId).catch(() => null) ?? "");
}

async function casPlannedRows(
  db: SupabaseClient,
  recordId: string,
  mutate: (rows: Record<string, unknown>[]) => { rows: Record<string, unknown>[]; outcome: "change" | "success" | "reject" },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data, updated_at")
      .eq("id", recordId)
      .maybeSingle();
    if (error || !data?.updated_at) return false;
    const next = mutate(rowsFromRecord(data.row_data));
    if (next.outcome === "success") return true;
    if (next.outcome === "reject") return false;
    const nextUpdatedAt = nextTourScheduleCasTimestamp(String(data.updated_at));
    if (!nextUpdatedAt) return false;
    const { data: claimed, error: writeError } = await db
      .from("portal_schedule_records")
      .update({
        row_data: {
          id: recordId,
          recordType: recordId,
          managerUserId: null,
          propertyId: null,
          payload: next.rows,
        },
        updated_at: nextUpdatedAt,
      })
      .eq("id", recordId)
      .eq("updated_at", data.updated_at)
      .select("id")
      .maybeSingle();
    if (writeError) return false;
    if (claimed?.id) return true;
  }
  return false;
}

export async function recordTourRescheduleSmsProposal(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    inquiryId: string;
    phone: string;
    start: string;
    end: string;
    generation?: string;
    recordId?: string;
    allowConversationEvidence?: boolean;
    expectedLegacySnapshot?: LegacyProposalSnapshot;
  },
): Promise<boolean> {
  const phoneE164 = phone(input.phone);
  // Existing generations retain the sender that actually received the message.
  // A current number can be absent or rotated by the time a delivery retry
  // repairs legacy metadata, so it is required only for a new proposal.
  const currentWorkNumber = await ownerWorkNumber(db, input.managerUserId);
  if (!phoneE164) return false;
  const eligibility = await resolveTourSmsEligibility(db, { managerUserId: input.managerUserId, guestPhone: phoneE164, explicitOptIn: false, purpose: "tour_rescheduled", inquiryId: input.inquiryId, allowConversationEvidence: input.allowConversationEvidence });
  if (!eligibility.eligible) return false;
  const recordId = input.recordId ?? PLANNED_RECORD_ID;
  const inquiryRecord = recordId === TOUR_INQUIRIES_RECORD_ID;
  return casPlannedRows(db, recordId, (rows) => {
    const index = rows.findIndex((row) =>
      (inquiryRecord ? text(row, "kind") === "tour" && text(row, "status") === "pending" : isActivePlannedTourEvent(row)) &&
      text(row, "managerUserId") === input.managerUserId &&
      (text(row, "sourceInquiryId") === input.inquiryId || text(row, "id") === input.inquiryId) &&
      (inquiryRecord ? text(row, "proposedStart") : text(row, "start")) === input.start &&
      (inquiryRecord ? text(row, "proposedEnd") : text(row, "end")) === input.end &&
      phone(text(row, inquiryRecord ? "phone" : "attendeePhone")) === phoneE164,
    );
    if (index < 0) return { rows, outcome: "reject" };
    const event = rows[index]!;
    const generation = input.generation?.trim() || "";
    const existing = proposal(event);
    const rowGeneration = text(event, "rescheduleNotificationGeneration");
    // A late recorder for A must not create or upgrade anything after B has
    // become the row's current transition, even if the windows are identical.
    if (!inputGenerationMatchesRow(generation, rowGeneration)) return { rows, outcome: "reject" };
    if (input.expectedLegacySnapshot) {
      // Legacy repair is deliberately upgrade-only. The original snapshot is
      // closed over by casPlannedRows, so every bounded retry checks A again
      // rather than accepting whatever proposal happened to replace it.
      if (!legacySnapshotMatches(event, existing, input.expectedLegacySnapshot)) {
        return { rows, outcome: "reject" };
      }
      const next = [...rows];
      next[index] = {
        ...event,
        guestRescheduleReply: {
          ...existing!,
          smsEligibility: "eligible",
          smsConsentProvenance: eligibility.provenance,
        } satisfies Proposal,
      };
      return { rows: next, outcome: "change" };
    }
    const existingVersionIsExact = Boolean(existing) &&
      existing!.phoneE164 === phoneE164 &&
      existing!.proposedStart === input.start && existing!.proposedEnd === input.end &&
      existing!.version === versionFor(text(event, "id"), input.start, input.end, phoneE164, existing!.generation || existing!.workNumber);
    const isSameOperation = Boolean(existing) && existingVersionIsExact &&
      generationsAgree(existing!.generation, rowGeneration) &&
      (generation ? existing!.generation === generation : Boolean(currentWorkNumber) && existing!.version === versionFor(text(event, "id"), input.start, input.end, phoneE164, currentWorkNumber));
    // A persisted transition generation names the actual outbound operation.
    // Retries must keep its original sender snapshot even if the manager's
    // number rotates before the retry reaches this writer.
    if (isSameOperation && existing?.status !== "awaiting_reply") {
      // A retry did not repair anything and must never imply that it did.
      return { rows, outcome: "reject" };
    }
    if (isSameOperation && existing?.smsEligibility === "eligible") {
      return { rows, outcome: "success" };
    }
    if (isSameOperation && existing && !existing.smsEligibility) {
      // This is a pre-PRP-473 proposal. The resolver above has just performed
      // current, exact-scope authorization; upgrade only this still-actionable
      // snapshot and preserve its original work number/version/window/status.
      const next = [...rows];
      next[index] = {
        ...event,
        guestRescheduleReply: {
          ...existing,
          smsEligibility: "eligible",
          smsConsentProvenance: eligibility.provenance,
        } satisfies Proposal,
      };
      return { rows: next, outcome: "change" };
    }
    if (!currentWorkNumber) return { rows, outcome: "reject" };
    const version = versionFor(text(event, "id"), input.start, input.end, phoneE164, generation || currentWorkNumber);
    const next = [...rows];
    next[index] = {
      ...event,
      guestRescheduleReply: {
        version,
        ...(generation ? { generation } : {}),
        proposedStart: input.start,
        proposedEnd: input.end,
        requestedAt: new Date().toISOString(),
        status: "awaiting_reply",
        phoneE164,
        workNumber: currentWorkNumber,
        conversationKey: eligibility.conversationKey,
        smsEligibility: "eligible",
        smsConsentProvenance: eligibility.provenance,
      } satisfies Proposal,
    };
    return { rows: next, outcome: "change" };
  });
}

export type TourRescheduleSmsReplyResult =
  | { handled: false }
  | { handled: true; kind: "confirmed" | "follow_up" | "ambiguous" | "duplicate" | "stale" | "unavailable"; reply: string };

function isAffirmative(body: string): boolean {
  return new Set(["YES", "Y", "CONFIRM", "CONFIRMED"]).has(body.toUpperCase().replace(/[.!?]/g, "").trim());
}

async function notifyTourReplyFollowUp(
  db: SupabaseClient,
  input: { managerUserId: string; messageSid: string; subject: string; text: string; purpose: string },
): Promise<boolean> {
  try {
    const result = await notifyManagerFromAgent(db, {
      landlordId: input.managerUserId,
      subject: input.subject,
      text: input.text,
      category: "leasing",
      threadType: input.purpose,
      idempotencyKey: `tour-reschedule:${input.messageSid}`,
    });
    return result.delivered;
  } catch {
    return false;
  }
}

type ActionableCandidate = {
  row: Record<string, unknown>;
  recordId: typeof PLANNED_RECORD_ID | typeof TOUR_INQUIRIES_RECORD_ID;
  inquiry: boolean;
};

function isDefinitiveLegacyDenial(reason: string): boolean {
  return new Set([
    "recipient_opted_out",
    "tour_sms_revoked",
    "tour_sms_consent_missing",
    "scoped_consent_missing",
  ]).has(reason);
}

function actionableCandidate(
  row: Record<string, unknown>,
  input: { managerUserId: string; fromPhone: string; toPhone: string },
  inquiry: boolean,
): ActionableCandidate | null {
  const saved = proposal(row);
  const start = inquiry ? text(row, "proposedStart") : text(row, "start");
  const end = inquiry ? text(row, "proposedEnd") : text(row, "end");
  if (!saved || (saved.smsEligibility !== "eligible" && saved.smsEligibility !== undefined) ||
    saved.status !== "awaiting_reply" || text(row, "managerUserId") !== input.managerUserId ||
    phone(text(row, inquiry ? "phone" : "attendeePhone")) !== input.fromPhone ||
    saved.phoneE164 !== input.fromPhone || saved.workNumber !== input.toPhone ||
    saved.proposedStart !== start || saved.proposedEnd !== end ||
    !generationsAgree(saved.generation, text(row, "rescheduleNotificationGeneration")) ||
    saved.version !== versionFor(text(row, "id"), start, end, saved.phoneE164, saved.generation || saved.workNumber) ||
    (inquiry ? text(row, "kind") !== "tour" || text(row, "status") !== "pending" : !isActivePlannedTourEvent(row))) {
    return null;
  }
  return { row, recordId: inquiry ? TOUR_INQUIRIES_RECORD_ID : PLANNED_RECORD_ID, inquiry };
}

function legacyRepairGuard(candidate: ActionableCandidate): LegacyRepairGuard {
  const saved = proposal(candidate.row)!;
  return {
    recordId: candidate.recordId,
    snapshot: {
      eventId: text(candidate.row, "id"),
      sourceInquiryId: text(candidate.row, "sourceInquiryId"),
      managerUserId: text(candidate.row, "managerUserId"),
      phoneE164: saved.phoneE164,
      workNumber: saved.workNumber,
      proposedStart: saved.proposedStart,
      proposedEnd: saved.proposedEnd,
      rowGeneration: text(candidate.row, "rescheduleNotificationGeneration"),
      proposalVersion: saved.version,
      proposalGeneration: saved.generation?.trim() ?? "",
      proposalStatus: saved.status,
      conversationKey: saved.conversationKey,
      requestedAt: saved.requestedAt,
      smsOrigin: candidate.row.smsOrigin,
      smsConsent: candidate.row.smsConsent,
    },
  };
}

function repairGuardTargetsCandidate(guard: LegacyRepairGuard, candidate: ActionableCandidate): boolean {
  return guard.recordId === candidate.recordId && guard.snapshot.eventId === text(candidate.row, "id");
}

async function resolveActionableCandidates(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string },
  candidates: ActionableCandidate[],
): Promise<{ candidates: ActionableCandidate[]; unreadable: boolean }> {
  const resolved: Array<{ candidate: ActionableCandidate; include: boolean; unreadable: boolean }> = [];
  for (const candidate of candidates) {
    const saved = proposal(candidate.row)!;
    if (saved.smsEligibility === "eligible") {
      resolved.push({ candidate, include: true, unreadable: false });
      continue;
    }
    try {
      const eligibility = await resolveTourSmsEligibility(db, {
        managerUserId: input.managerUserId,
        guestPhone: input.fromPhone,
        explicitOptIn: false,
        purpose: "tour_rescheduled",
        allowConversationEvidence: candidate.row.smsOrigin === "non_sms" ? false : undefined,
        inquiryId: text(candidate.row, "sourceInquiryId") || text(candidate.row, "id"),
      });
      if (eligibility.eligible) {
        // A mismatch is unresolved, not a denial. Dropping it could turn a
        // mixed inventory into an unsafe modern singleton.
        resolved.push({
          candidate,
          include: eligibility.conversationKey === saved.conversationKey,
          unreadable: eligibility.conversationKey !== saved.conversationKey,
        });
        continue;
      }
      resolved.push({ candidate, include: false, unreadable: !isDefinitiveLegacyDenial(eligibility.reason) });
    } catch {
      resolved.push({ candidate, include: false, unreadable: true });
    }
  }
  return {
    candidates: resolved.filter((result) => result.include).map((result) => result.candidate),
    unreadable: resolved.some((result) => result.unreadable),
  };
}

async function handlePendingInquiryYes(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string; body: string; messageSid: string },
  target: ActionableCandidate,
  repairGuard?: LegacyRepairGuard,
): Promise<TourRescheduleSmsReplyResult> {
  if (!isAffirmative(input.body)) {
    const delivered = await notifyTourReplyFollowUp(db, { managerUserId: input.managerUserId, messageSid: input.messageSid, subject: "Tour reschedule needs follow-up", text: `A prospect replied to a tour update: ${input.body.trim()}`, purpose: "tour_reschedule_guest_follow_up" });
    return delivered ? { handled: true, kind: "follow_up", reply: "Thanks. Your property manager will follow up about another tour time." } : { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
  }
  const expected = proposal(target.row)!;
  const changed = await casPlannedRows(db, TOUR_INQUIRIES_RECORD_ID, (freshRows) => {
    const index = freshRows.findIndex((row) => text(row, "id") === text(target.row, "id"));
    const fresh = index < 0 ? null : freshRows[index]!;
    const current = fresh ? proposal(fresh) : null;
    if (!fresh || (repairGuard && !upgradedLegacySnapshotMatches(fresh, current, repairGuard.snapshot)) || text(fresh, "kind") !== "tour" || text(fresh, "status") !== "pending" || text(fresh, "managerUserId") !== input.managerUserId || phone(text(fresh, "phone")) !== input.fromPhone || !current || current.smsEligibility !== "eligible" || current.status !== "awaiting_reply" || current.version !== expected.version || current.generation !== expected.generation || current.workNumber !== input.toPhone || current.phoneE164 !== input.fromPhone || current.proposedStart !== text(fresh, "proposedStart") || current.proposedEnd !== text(fresh, "proposedEnd") || !generationsAgree(current.generation, text(fresh, "rescheduleNotificationGeneration"))) return { rows: freshRows, outcome: "reject" };
    const next = [...freshRows];
    next[index] = { ...fresh, guestRescheduleReply: { ...current, status: "confirmed", confirmedAt: new Date().toISOString(), inboundMessageSid: input.messageSid, replyText: input.body.trim() } };
    return { rows: next, outcome: "change" };
  });
  return changed
    ? { handled: true, kind: "confirmed", reply: "Thanks. The property manager has your confirmation for the proposed tour time." }
    : { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
}

async function handleTourRescheduleSmsReplyInternal(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string; body: string; messageSid: string },
  repairGuard?: LegacyRepairGuard,
): Promise<TourRescheduleSmsReplyResult> {
  const fromPhone = phone(input.fromPhone);
  const toPhone = phone(input.toPhone);
  if (!fromPhone || !toPhone || !input.messageSid.trim()) return { handled: false };
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (error) return { handled: true, kind: "unavailable", reply: "We could not check that tour update just now. Please try again shortly." };
  const rows = rowsFromRecord(data?.row_data);
  const pairProposals = rows.filter((row) => {
    const saved = proposal(row);
    return text(row, "managerUserId") === input.managerUserId &&
      phone(text(row, "attendeePhone")) === fromPhone &&
      saved?.phoneE164 === fromPhone &&
      saved.workNumber === toPhone;
  });
  const { data: inquiryData, error: inquiryError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", TOUR_INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (inquiryError) return { handled: true, kind: "unavailable", reply: "We could not check that tour update just now. Please try again shortly." };
  const inquiryRows = rowsFromRecord(inquiryData?.row_data);
  if (repairGuard) {
    const guardedRows = repairGuard.recordId === TOUR_INQUIRIES_RECORD_ID ? inquiryRows : rows;
    const guardedRow = guardedRows.find((row) => text(row, "id") === repairGuard.snapshot.eventId);
    if (!guardedRow || !upgradedLegacySnapshotMatches(guardedRow, proposal(guardedRow), repairGuard.snapshot)) {
      return { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
    }
  }
  const inquiryPairProposals = inquiryRows.filter((row) => {
    const saved = proposal(row);
    return text(row, "managerUserId") === input.managerUserId &&
      phone(text(row, "phone")) === fromPhone && saved?.phoneE164 === fromPhone && saved.workNumber === toPhone;
  });
  const duplicates = [...pairProposals, ...inquiryPairProposals]
    .filter((row) => proposal(row)?.inboundMessageSid === input.messageSid);
  if (duplicates.length === 1) {
    const saved = proposal(duplicates[0]!)!;
    return {
      handled: true,
      kind: "duplicate",
      reply: saved.status === "confirmed"
        ? inquiryPairProposals.includes(duplicates[0]!)
          ? "The property manager already has your confirmation for the proposed tour time."
          : `Your new tour time is confirmed for ${formatPacificDateTime(new Date(saved.proposedStart))}.`
        : "Your reply was already sent to the property manager.",
    };
  }
  const rawCandidates = [
    ...rows.map((row) => actionableCandidate(row, { managerUserId: input.managerUserId, fromPhone, toPhone }, false)),
    ...inquiryRows.map((row) => actionableCandidate(row, { managerUserId: input.managerUserId, fromPhone, toPhone }, true)),
  ].filter((candidate): candidate is ActionableCandidate => candidate !== null);
  // Resolve every legacy row before choosing a singleton. A resolver read that
  // is unavailable is not a denial: confirming a modern row in that state
  // would consume a reply whose legacy target cannot be ruled out.
  const inventory = await resolveActionableCandidates(db, { managerUserId: input.managerUserId, fromPhone, toPhone }, rawCandidates);
  if (inventory.unreadable || inventory.candidates.length > 1) {
    const delivered = await notifyTourReplyFollowUp(db, {
      managerUserId: input.managerUserId,
      messageSid: input.messageSid,
      subject: "Ambiguous tour reschedule reply",
      text: `A prospect with more than one pending tour update replied: ${input.body.trim()}`,
      purpose: "tour_reschedule_ambiguous_reply",
    });
    return delivered
      ? { handled: true, kind: "ambiguous", reply: "Thanks. Your property manager will follow up to confirm the right tour." }
      : { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
  }
  if (inventory.candidates.length === 0) {
    return pairProposals.length + inquiryPairProposals.length > 0 && isAffirmative(input.body)
      ? { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." }
      : { handled: false };
  }
  const target = inventory.candidates[0]!;
  if (repairGuard && !repairGuardTargetsCandidate(repairGuard, target)) {
    return { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
  }
  const expected = proposal(target.row)!;
  if (expected.smsEligibility === undefined) {
    const guard = legacyRepairGuard(target);
    const repaired = await recordTourRescheduleSmsProposal(db, {
      managerUserId: input.managerUserId,
      inquiryId: text(target.row, "sourceInquiryId") || text(target.row, "id"),
      phone: fromPhone,
      start: target.inquiry ? text(target.row, "proposedStart") : text(target.row, "start"),
      end: target.inquiry ? text(target.row, "proposedEnd") : text(target.row, "end"),
      generation: guard.snapshot.rowGeneration || undefined,
      recordId: target.recordId,
      allowConversationEvidence: target.row.smsOrigin === "non_sms" ? false : undefined,
      expectedLegacySnapshot: guard.snapshot,
    });
    return repaired
      ? handleTourRescheduleSmsReplyInternal(db, input, guard)
      : { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
  }
  if (target.inquiry) return handlePendingInquiryYes(db, { ...input, fromPhone, toPhone }, target, repairGuard);
  const targetId = text(target.row, "id");
  const affirmative = isAffirmative(input.body);
  const nextStatus: ProposalStatus = affirmative ? "confirmed" : "needs_manager_follow_up";
  if (!affirmative) {
    const delivered = await notifyTourReplyFollowUp(db, {
      managerUserId: input.managerUserId,
      messageSid: input.messageSid,
      subject: "Tour reschedule needs follow-up",
      text: `A prospect replied to the tour update for ${text(target.row, "propertyTitle") || "a property"}: ${input.body.trim()}`,
      purpose: "tour_reschedule_guest_follow_up",
    });
    // Do not spend the inbound SID until a manager has a durable notice. The
    // same SID retries safely through the notice's stable idempotency key.
    if (!delivered) {
      return { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
    }
  }
  const changed = await casPlannedRows(db, PLANNED_RECORD_ID, (freshRows) => {
    const index = freshRows.findIndex((row) => text(row, "id") === targetId);
    if (index < 0 || !isActivePlannedTourEvent(freshRows[index]!)) return { rows: freshRows, outcome: "reject" };
    const fresh = freshRows[index]!;
    const current = proposal(fresh);
    if (!current || (repairGuard && !upgradedLegacySnapshotMatches(fresh, current, repairGuard.snapshot)) || current.version !== expected.version || current.generation !== expected.generation || current.status !== "awaiting_reply" ||
      text(fresh, "managerUserId") !== input.managerUserId ||
      phone(text(fresh, "attendeePhone")) !== fromPhone ||
      current.smsEligibility !== "eligible" ||
      current.phoneE164 !== fromPhone || current.workNumber !== toPhone ||
      current.proposedStart !== text(fresh, "start") || current.proposedEnd !== text(fresh, "end") ||
      !generationsAgree(current.generation, text(fresh, "rescheduleNotificationGeneration")) ||
      current.version !== versionFor(text(fresh, "id"), text(fresh, "start"), text(fresh, "end"), current.phoneE164, current.generation || current.workNumber)) {
      return { rows: freshRows, outcome: "reject" };
    }
    const next = [...freshRows];
    next[index] = {
      ...fresh,
      guestRescheduleReply: {
        ...current,
        status: nextStatus,
        inboundMessageSid: input.messageSid,
        replyText: input.body.trim(),
        ...(affirmative
          ? { confirmedAt: new Date().toISOString() }
          : { followUpRequestedAt: new Date().toISOString() }),
      } satisfies Proposal,
    };
    return { rows: next, outcome: "change" };
  });
  if (!changed) {
    return { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
  }
  if (affirmative) {
    return {
      handled: true,
      kind: "confirmed",
      reply: `Your new tour time is confirmed for ${formatPacificDateTime(new Date(expected.proposedStart))}.`,
    };
  }
  return {
    handled: true,
    kind: "follow_up",
    reply: "Thanks. Your property manager will follow up about another tour time.",
  };
}

export async function handleTourRescheduleSmsReply(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string; body: string; messageSid: string },
): Promise<TourRescheduleSmsReplyResult> {
  return handleTourRescheduleSmsReplyInternal(db, input);
}
