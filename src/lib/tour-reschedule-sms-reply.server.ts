import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { normalizeE164 } from "@/lib/twilio";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";

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
  confirmedAt?: string;
  followUpRequestedAt?: string;
  replyText?: string;
  inboundMessageSid?: string;
};

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? String(row[key]).trim() : "";
}

function proposal(row: Record<string, unknown>): Proposal | null {
  const value = row.guestRescheduleReply;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Proposal;
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
  input: { managerUserId: string; inquiryId: string; phone: string; start: string; end: string; generation?: string; recordId?: string },
): Promise<boolean> {
  const phoneE164 = phone(input.phone);
  const workNumber = await ownerWorkNumber(db, input.managerUserId);
  if (!phoneE164 || !workNumber) return false;
  const recordId = input.recordId ?? PLANNED_RECORD_ID;
  const inquiryRecord = recordId === TOUR_INQUIRIES_RECORD_ID;
  return casPlannedRows(db, recordId, (rows) => {
    const index = rows.findIndex((row) =>
      (inquiryRecord ? text(row, "kind") === "tour" && text(row, "status") === "pending" : isActivePlannedTourEvent(row)) &&
      text(row, "managerUserId") === input.managerUserId &&
      (text(row, "sourceInquiryId") === input.inquiryId || text(row, "id") === input.inquiryId) &&
      (inquiryRecord ? text(row, "proposedStart") : text(row, "start")) === input.start &&
      (inquiryRecord ? text(row, "proposedEnd") : text(row, "end")) === input.end &&
      phone(text(row, inquiryRecord ? "phone" : "attendeePhone")) === phoneE164 &&
      row.smsConsent === true,
    );
    if (index < 0) return { rows, outcome: "reject" };
    const event = rows[index]!;
    const generation = input.generation?.trim() || "";
    const version = versionFor(text(event, "id"), input.start, input.end, phoneE164, generation || workNumber);
    const existing = proposal(event);
    // A persisted transition generation names the actual outbound operation.
    // Retries must keep its original sender snapshot even if the manager's
    // number rotates before the retry reaches this writer.
    if (generation && existing?.generation === generation) {
      return { rows, outcome: "success" };
    }
    if (!generation && existing?.version === version) {
      return { rows, outcome: "success" };
    }
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
        workNumber,
        conversationKey: buildConversationKey({
          ownerManagerUserId: input.managerUserId,
          role: "prospect",
          counterpartyPhone: phoneE164,
        }),
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

async function handlePendingInquiryYes(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string; body: string; messageSid: string },
  rows: Record<string, unknown>[],
): Promise<TourRescheduleSmsReplyResult> {
  const duplicate = rows.find((row) => {
    const saved = proposal(row);
    return text(row, "managerUserId") === input.managerUserId && phone(text(row, "phone")) === input.fromPhone && saved?.workNumber === input.toPhone && saved.inboundMessageSid === input.messageSid;
  });
  if (duplicate) return { handled: true, kind: "duplicate", reply: "Your reply was already sent to the property manager." };
  const matches = rows.filter((row) => {
    const saved = proposal(row);
    return text(row, "kind") === "tour" && text(row, "status") === "pending" &&
      text(row, "managerUserId") === input.managerUserId && phone(text(row, "phone")) === input.fromPhone &&
      row.smsConsent === true &&
      saved?.status === "awaiting_reply" && saved.phoneE164 === input.fromPhone && saved.workNumber === input.toPhone &&
      saved.proposedStart === text(row, "proposedStart") && saved.proposedEnd === text(row, "proposedEnd") &&
      saved.generation === text(row, "rescheduleNotificationGeneration") &&
      saved.version === versionFor(text(row, "id"), text(row, "proposedStart"), text(row, "proposedEnd"), saved.phoneE164, saved.generation || saved.workNumber);
  });
  if (matches.length === 0) return { handled: false };
  if (matches.length > 1) {
    const delivered = await notifyTourReplyFollowUp(db, { managerUserId: input.managerUserId, messageSid: input.messageSid, subject: "Ambiguous tour reschedule reply", text: `A prospect with more than one pending tour update replied: ${input.body.trim()}`, purpose: "tour_reschedule_ambiguous_reply" });
    return delivered ? { handled: true, kind: "ambiguous", reply: "Thanks. Your property manager will follow up to confirm the right tour." } : { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
  }
  if (!isAffirmative(input.body)) {
    const delivered = await notifyTourReplyFollowUp(db, { managerUserId: input.managerUserId, messageSid: input.messageSid, subject: "Tour reschedule needs follow-up", text: `A prospect replied to a tour update: ${input.body.trim()}`, purpose: "tour_reschedule_guest_follow_up" });
    return delivered ? { handled: true, kind: "follow_up", reply: "Thanks. Your property manager will follow up about another tour time." } : { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
  }
  const target = matches[0]!;
  const expected = proposal(target)!;
  const changed = await casPlannedRows(db, TOUR_INQUIRIES_RECORD_ID, (freshRows) => {
    const index = freshRows.findIndex((row) => text(row, "id") === text(target, "id"));
    const fresh = index < 0 ? null : freshRows[index]!;
    const current = fresh ? proposal(fresh) : null;
    if (!fresh || text(fresh, "kind") !== "tour" || text(fresh, "status") !== "pending" || text(fresh, "managerUserId") !== input.managerUserId || phone(text(fresh, "phone")) !== input.fromPhone || fresh.smsConsent !== true || !current || current.status !== "awaiting_reply" || current.version !== expected.version || current.generation !== expected.generation || current.workNumber !== input.toPhone || current.phoneE164 !== input.fromPhone || current.proposedStart !== text(fresh, "proposedStart") || current.proposedEnd !== text(fresh, "proposedEnd") || current.generation !== text(fresh, "rescheduleNotificationGeneration")) return { rows: freshRows, outcome: "reject" };
    const next = [...freshRows];
    next[index] = { ...fresh, guestRescheduleReply: { ...current, status: "confirmed", confirmedAt: new Date().toISOString(), inboundMessageSid: input.messageSid, replyText: input.body.trim() } };
    return { rows: next, outcome: "change" };
  });
  return changed
    ? { handled: true, kind: "confirmed", reply: "Thanks. The property manager has your confirmation for the proposed tour time." }
    : { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." };
}

export async function handleTourRescheduleSmsReply(
  db: SupabaseClient,
  input: { managerUserId: string; fromPhone: string; toPhone: string; body: string; messageSid: string },
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
  const scopedProposals = pairProposals.filter((row) => {
    const pending = proposal(row);
    return pending?.status === "awaiting_reply";
  });
  const matches = scopedProposals.filter((row) => {
    const pending = proposal(row)!;
    return isActivePlannedTourEvent(row) &&
      row.smsConsent === true &&
      pending.proposedStart === text(row, "start") &&
      pending.proposedEnd === text(row, "end") &&
      pending.version === versionFor(text(row, "id"), text(row, "start"), text(row, "end"), pending.phoneE164, pending.generation || pending.workNumber);
  });
  const { data: inquiryData, error: inquiryError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", TOUR_INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (inquiryError) return { handled: true, kind: "unavailable", reply: "We could not check that tour update just now. Please try again shortly." };
  const inquiryRows = rowsFromRecord(inquiryData?.row_data);
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
  const inquiryMatches = inquiryRows.filter((row) => {
    const saved = proposal(row);
    return text(row, "kind") === "tour" && text(row, "status") === "pending" &&
      text(row, "managerUserId") === input.managerUserId && phone(text(row, "phone")) === fromPhone &&
      row.smsConsent === true && saved?.status === "awaiting_reply" && saved.phoneE164 === fromPhone && saved.workNumber === toPhone &&
      saved.proposedStart === text(row, "proposedStart") && saved.proposedEnd === text(row, "proposedEnd") &&
      saved.generation === text(row, "rescheduleNotificationGeneration") &&
      saved.version === versionFor(text(row, "id"), text(row, "proposedStart"), text(row, "proposedEnd"), saved.phoneE164, saved.generation || saved.workNumber);
  });
  if (matches.length + inquiryMatches.length > 1) {
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
  if (matches.length === 0) {
    const inquiryReply = await handlePendingInquiryYes(db, { ...input, fromPhone, toPhone }, inquiryRows);
    if (inquiryReply.handled) return inquiryReply;
    return pairProposals.length + inquiryPairProposals.length > 0 && isAffirmative(input.body)
      ? { handled: true, kind: "stale", reply: "That tour update is no longer awaiting a reply. The property manager has the latest schedule." }
      : { handled: false };
  }
  if (matches.length > 1) {
    const delivered = await notifyTourReplyFollowUp(db, {
      managerUserId: input.managerUserId,
      messageSid: input.messageSid,
      subject: "Ambiguous tour reschedule reply",
      text: `A prospect with more than one pending tour update replied: ${input.body.trim()}`,
      purpose: "tour_reschedule_ambiguous_reply",
    });
    if (!delivered) {
      return { handled: true, kind: "unavailable", reply: "We could not reach the property manager just now. Please try again shortly." };
    }
    return { handled: true, kind: "ambiguous", reply: "Thanks. Your property manager will follow up to confirm the right tour." };
  }
  const target = matches[0]!;
  const targetId = text(target, "id");
  const expected = proposal(target)!;
  const affirmative = isAffirmative(input.body);
  const nextStatus: ProposalStatus = affirmative ? "confirmed" : "needs_manager_follow_up";
  if (!affirmative) {
    const delivered = await notifyTourReplyFollowUp(db, {
      managerUserId: input.managerUserId,
      messageSid: input.messageSid,
      subject: "Tour reschedule needs follow-up",
      text: `A prospect replied to the tour update for ${text(target, "propertyTitle") || "a property"}: ${input.body.trim()}`,
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
    if (!current || current.version !== expected.version || current.status !== "awaiting_reply" ||
      text(fresh, "managerUserId") !== input.managerUserId ||
      phone(text(fresh, "attendeePhone")) !== fromPhone ||
      fresh.smsConsent !== true ||
      current.phoneE164 !== fromPhone || current.workNumber !== toPhone ||
      current.proposedStart !== text(fresh, "start") || current.proposedEnd !== text(fresh, "end") ||
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
