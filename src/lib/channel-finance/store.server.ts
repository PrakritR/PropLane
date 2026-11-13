import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadChannelRoomCandidates } from "@/lib/manager-assistant-email/channel-guest-message.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { importedRangeUid } from "@/lib/channel-calendar/stay-tombstones";
import { matchFinanceFacts, type FinanceMatch, type FinanceRoomCandidate } from "./match";
import type { ChannelFinanceFacts, ChannelFinanceRecord, FinancePlatform, FinanceReviewStatus } from "./types";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

export function recordFromRow(raw: Row): ChannelFinanceRecord {
  return {
    id: String(raw.id),
    platform: raw.platform as FinancePlatform,
    kind: raw.kind as ChannelFinanceRecord["kind"],
    confirmationCode: String(raw.confirmation_code),
    propertyId: str(raw.property_id),
    propertyLabel: str(raw.property_label),
    roomId: str(raw.room_id),
    roomLabel: str(raw.room_label),
    connectionId: str(raw.connection_id),
    sourceUid: str(raw.source_uid),
    guestLabel: str(raw.guest_label),
    checkIn: str(raw.check_in),
    checkOut: str(raw.check_out),
    grossCents: int(raw.gross_cents),
    hostFeeCents: int(raw.host_fee_cents),
    taxCents: int(raw.tax_cents),
    payoutCents: int(raw.payout_cents),
    currency: str(raw.currency) ?? "USD",
    paidAt: str(raw.paid_at),
    source: raw.source === "csv" ? "csv" : "email",
    reviewStatus: (["ok", "needs_room", "needs_review"].includes(String(raw.review_status)) ? raw.review_status : "ok") as FinanceReviewStatus,
  };
}

/** The workspace owner's linked rooms on the channels, with their synced stays: what a booking is matched against. Never throws. */
export async function loadFinanceCandidates(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null },
): Promise<FinanceRoomCandidate[]> {
  try {
    const labels = new Map<string, Awaited<ReturnType<typeof loadChannelRoomCandidates>>[number]>();
    for (const site of ["airbnb", "booking_com"] as const) {
      for (const c of await loadChannelRoomCandidates(db, { ...input, site })) labels.set(`${site}:${c.propertyId}:${c.roomId}`, c);
    }
    const { data, error } = await db.from("external_calendar_connections").select("*").eq("manager_user_id", input.ownerUserId);
    if (error) return [];
    const out: FinanceRoomCandidate[] = [];
    for (const raw of data ?? []) {
      const connection = parseConnectionRow(raw as Row);
      if (connection.provider !== "airbnb" && connection.provider !== "booking_com") continue;
      const label = labels.get(`${connection.provider}:${connection.property_id}:${connection.room_id}`);
      if (!label) continue;
      out.push({
        ...label,
        connectionId: connection.id,
        ranges: connection.imported_ranges
          .filter((r) => !r.hostBlock)
          .map((r) => ({ code: r.reservationCode ?? null, start: r.start, end: (r.end ?? "").trim() || r.start, sourceUid: importedRangeUid(r) })),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export type RecordOutcome = { id: string; reviewStatus: FinanceReviewStatus; created: boolean; unchanged: boolean };

/**
 * Upsert ONE (platform, code, kind). Idempotent: the same facts twice change nothing. A confirmed record is never downgraded by
 * an uncertain re-read, and a room a person assigned is never replaced by a guess. `review` = what the CALLER vouches for:
 * "ok" (certain mail, or a CSV the manager previewed) or "needs_review" (stored, counted nowhere until confirmed).
 */
export async function recordFinanceFacts(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    facts: ChannelFinanceFacts;
    source: "email" | "csv";
    review: "ok" | "needs_review";
    emailId?: string | null;
    candidates: readonly FinanceRoomCandidate[];
    receivedAt?: string;
  },
): Promise<RecordOutcome | null> {
  const { facts } = input;
  // Scoped to THIS workspace both ways: a booking of the same code in another of the owner's workspaces is a different
  // record, never this one re-pointed (`channel_payout_records_workspace_key_idx`).
  const read = db
    .from("channel_payout_records")
    .select("*")
    .eq("manager_user_id", input.ownerUserId)
    .eq("platform", facts.platform)
    .eq("confirmation_code", facts.confirmationCode)
    .in("kind", ["reservation", "payout"]);
  const { data: existingRaw, error: readError } = await (input.workspaceId === null
    ? read.is("workspace_id", null)
    : read.eq("workspace_id", input.workspaceId));
  if (readError) return null;
  const existingRows = ((existingRaw ?? []) as Row[]).map(recordFromRow);
  const existing = existingRows.find((r) => r.kind === facts.kind) ?? null;
  // A room already settled (by a match or a person) on either kind of this booking carries over.
  const settled = existingRows.find((r) => r.roomId);

  let match: FinanceMatch | null = null;
  if (settled) match = { propertyId: settled.propertyId!, propertyLabel: settled.propertyLabel ?? "", roomId: settled.roomId, roomLabel: settled.roomLabel, connectionId: settled.connectionId, sourceUid: settled.sourceUid, via: "reservation_code" };
  else match = matchFinanceFacts(facts, input.candidates);
  const roomKnown = Boolean(match?.roomId);

  if (existing?.reviewStatus === "ok" && input.review === "needs_review") return { id: existing.id, reviewStatus: "ok", created: false, unchanged: true };
  const reviewStatus: FinanceReviewStatus = input.review === "needs_review" ? "needs_review" : roomKnown ? "ok" : "needs_room";

  const paidAt = facts.paidOn ? `${facts.paidOn}T12:00:00Z` : null;
  const values: Row = {
    manager_user_id: input.ownerUserId,
    workspace_id: input.workspaceId,
    platform: facts.platform,
    kind: facts.kind,
    confirmation_code: facts.confirmationCode,
    property_id: match?.propertyId ?? null,
    property_label: match?.propertyLabel ?? null,
    room_id: match?.roomId ?? null,
    room_label: match?.roomLabel ?? null,
    connection_id: match?.connectionId ?? null,
    source_uid: match?.sourceUid ?? null,
    guest_label: facts.guestLabel ?? existing?.guestLabel ?? null,
    check_in: facts.checkIn ?? existing?.checkIn ?? null,
    check_out: facts.checkOut ?? existing?.checkOut ?? null,
    gross_cents: facts.grossCents ?? existing?.grossCents ?? null,
    host_fee_cents: facts.hostFeeCents ?? existing?.hostFeeCents ?? null,
    tax_cents: facts.taxCents ?? existing?.taxCents ?? null,
    payout_cents: facts.payoutCents ?? existing?.payoutCents ?? null,
    currency: facts.currency,
    paid_at: paidAt ?? existing?.paidAt ?? null,
    source: input.source,
    review_status: reviewStatus,
    email_id: input.emailId ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("channel_payout_records")
    .upsert(values, { onConflict: "manager_user_id,platform,confirmation_code,kind,workspace_key" })
    .select("id")
    .maybeSingle();
  if (error || !data) return null;
  return { id: String((data as Row).id), reviewStatus, created: !existing, unchanged: false };
}

export async function recordFinanceMail(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; platform: FinancePlatform; emailId: string; subject: string; text: string; receivedAt: string; status: "recorded" | "flagged"; recordId?: string | null },
): Promise<void> {
  try {
    await db.from("channel_finance_mail").upsert(
      {
        manager_user_id: input.ownerUserId,
        workspace_id: input.workspaceId,
        platform: input.platform,
        email_id: input.emailId,
        subject: input.subject.slice(0, 300),
        excerpt: input.text.replace(/\s+/g, " ").trim().slice(0, 3900),
        received_at: input.receivedAt,
        status: input.status,
        record_id: input.recordId ?? null,
      },
      { onConflict: "manager_user_id,email_id" },
    );
  } catch {
    /* the log is best-effort; the record (if any) is already saved */
  }
}

/** One workspace, never another's: its owner, its id, and (for the owner's default workspace only) rows mail filed before a workspace was known. */
export type FinanceScope = { ownerUserId: string; workspaceId: string; includeUnplaced: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inScope<T>(query: T, scope: FinanceScope): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (query as any).eq("manager_user_id", scope.ownerUserId);
  return (scope.includeUnplaced ? q.or(`workspace_id.eq.${scope.workspaceId},workspace_id.is.null`) : q.eq("workspace_id", scope.workspaceId)) as T;
}

export async function listFinanceRecords(db: SupabaseClient, scope: FinanceScope): Promise<ChannelFinanceRecord[]> {
  const { data, error } = await inScope(db.from("channel_payout_records").select("*"), scope).order("updated_at", { ascending: false }).limit(5000);
  if (error) throw new Error("Could not load channel income.");
  return ((data ?? []) as Row[]).map(recordFromRow);
}

export type FinanceMailSummary = { platform: FinancePlatform; lastReceivedAt: string | null; flagged: { id: string; subject: string; receivedAt: string }[] };

export async function financeMailSummary(db: SupabaseClient, scope: FinanceScope): Promise<FinanceMailSummary[]> {
  const { data } = await inScope(db.from("channel_finance_mail").select("id, platform, subject, received_at, status, record_id"), scope)
    .order("received_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as Row[];
  return (["airbnb", "booking_com"] as const).map((platform) => {
    const mine = rows.filter((r) => r.platform === platform);
    return {
      platform,
      lastReceivedAt: mine.length ? String(mine[0]!.received_at) : null,
      flagged: mine.filter((r) => r.status === "flagged" && !r.record_id).slice(0, 20).map((r) => ({ id: String(r.id), subject: String(r.subject), receivedAt: String(r.received_at) })),
    };
  });
}

export async function dismissFinanceMail(db: SupabaseClient, scope: FinanceScope, mailId: string): Promise<boolean> {
  const { error } = await inScope(db.from("channel_finance_mail").update({ status: "dismissed" }).eq("id", mailId), scope);
  return !error;
}

/** A person picks the room for a "Needs a room" booking. The room must be one of the owner's own linked rooms (re-derived here, never trusted from the body). */
export async function assignFinanceRoom(
  db: SupabaseClient,
  input: { scope: FinanceScope; recordId: string; propertyId: string; roomId: string },
): Promise<{ ok: true } | { ok: false; status: 404 | 400 | 500; error: string }> {
  const { data: target } = await inScope(db.from("channel_payout_records").select("platform, confirmation_code").eq("id", input.recordId), input.scope).maybeSingle();
  if (!target) return { ok: false, status: 404, error: "Not found." };
  const t = target as Row;
  const candidates = await loadFinanceCandidates(db, { ownerUserId: input.scope.ownerUserId, workspaceId: input.scope.workspaceId });
  const room = candidates.find((c) => c.propertyId === input.propertyId && c.roomId === input.roomId && c.connectionId);
  if (!room) return { ok: false, status: 400, error: "Pick one of your rooms." };
  // Both kinds of THIS booking in THIS workspace: the same scope the row was read under, never the owner's other workspaces.
  const { error } = await inScope(
    db
      .from("channel_payout_records")
      .update({ property_id: room.propertyId, property_label: room.propertyLabel, room_id: room.roomId, room_label: room.roomLabel, updated_at: new Date().toISOString() })
      .eq("platform", t.platform as string)
      .eq("confirmation_code", t.confirmation_code as string),
    input.scope,
  );
  if (error) return { ok: false, status: 500, error: "Could not save the room." };
  // A room fills "needs_room" only; a row still waiting for review stays there.
  await inScope(
    db
      .from("channel_payout_records")
      .update({ review_status: "ok" })
      .eq("platform", t.platform as string)
      .eq("confirmation_code", t.confirmation_code as string)
      .eq("review_status", "needs_room"),
    input.scope,
  );
  return { ok: true };
}

/** A person vouches for a mail the parser would not: its stored amounts start counting (or wait for a room). */
export async function confirmFinanceRecord(db: SupabaseClient, scope: FinanceScope, recordId: string): Promise<boolean> {
  const { data } = await inScope(db.from("channel_payout_records").select("*").eq("id", recordId), scope).maybeSingle();
  if (!data) return false;
  const record = recordFromRow(data as Row);
  const next: FinanceReviewStatus = record.roomId ? "ok" : "needs_room";
  const { error } = await db
    .from("channel_payout_records")
    .update({ review_status: next, updated_at: new Date().toISOString() })
    .eq("id", recordId)
    .eq("manager_user_id", scope.ownerUserId);
  if (!error) await db.from("channel_finance_mail").update({ status: "recorded" }).eq("record_id", recordId).eq("manager_user_id", scope.ownerUserId);
  return !error;
}

/** Let a person correct nothing silently: a record can only be deleted by its owner (a mis-filed mail). */
export async function deleteFinanceRecord(db: SupabaseClient, scope: FinanceScope, recordId: string): Promise<boolean> {
  const { error } = await inScope(db.from("channel_payout_records").delete().eq("id", recordId), scope);
  return !error;
}
