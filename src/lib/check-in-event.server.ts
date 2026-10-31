import "server-only";

/**
 * The "I'm in" tap on the Check-in guide (captain decision D3).
 *
 * One tap after arrival: the stay (or the move-in) is stamped `checkedInAt`, and the workspace owner
 * gets ONE Assistant notice on the action-event bus - "<First name> checked in to <house> <room>" -
 * which shows on Bookings as "Checked in". Skipping the tap changes nothing.
 *
 * Idempotent three ways: the stamp is a compare-and-set on a null `checkedInAt` (only the first tap
 * writes), the event id is `resident_checked_in:<key>` (the bus upserts on it, so a retry never
 * notifies twice), and a second tap answers `alreadyCheckedIn` without emitting.
 *
 * The caller is the signed-in resident/guest and the key is re-derived against THEIR login or email:
 * a key in the request body is a name, never a grant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedInNoticeText } from "@/lib/check-in-notice-text";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { loadStayCheckIn, loadTenancyCheckInContext, tenancyReveal } from "@/lib/check-in.server";
import { loadResidentLeaseSignedStatus, loadResidentManagerAttestedTenancy } from "@/lib/resident-portal-access";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";

export const RESIDENT_CHECKED_IN_EVENT = "resident_checked_in";

export type CheckInKey = { kind: "stay"; id: string } | { kind: "tenancy"; id: string };

export function parseCheckInKey(raw: unknown): CheckInKey | null {
  if (typeof raw !== "string") return null;
  const match = /^(stay|tenancy):([A-Za-z0-9_.:-]{1,200})$/.exec(raw.trim());
  return match ? { kind: match[1] as "stay" | "tenancy", id: match[2]! } : null;
}

export type RecordCheckInResult =
  | { ok: true; checkedInAt: string; alreadyCheckedIn: boolean }
  | { ok: false; status: number; error: string };

type StampTarget = { subjectId?: string; table: "portal_schedule_records" | "manager_application_records"; id: string; path: "stayDetails" | "root" };

/** Compare-and-set `checkedInAt`: true only for the tap that wrote it. */
async function stampCheckedIn(db: SupabaseClient, target: StampTarget, atIso: string): Promise<{ stamped: boolean; existing: string | null }> {
  const { data, error } = await db.from(target.table).select("row_data").eq("id", target.id).maybeSingle();
  if (error || !data) throw new Error("Could not read the stay.");
  const rowData = ((data as { row_data?: unknown }).row_data ?? {}) as Record<string, unknown>;
  if (target.subjectId && rowData.residentUserId !== target.subjectId) throw new Error("Move-in no longer belongs to this account.");
  const details = (target.path === "stayDetails" ? rowData.stayDetails ?? {} : rowData) as Record<string, unknown>;
  const already = typeof details.checkedInAt === "string" && details.checkedInAt.trim() ? details.checkedInAt.trim() : null;
  if (already) return { stamped: false, existing: already };
  const next =
    target.path === "stayDetails"
      ? { ...rowData, stayDetails: { ...(details as Record<string, unknown>), checkedInAt: atIso } }
      : { ...rowData, checkedInAt: atIso };
  const filterColumn = target.path === "stayDetails" ? "row_data->stayDetails->>checkedInAt" : "row_data->>checkedInAt";
  let update = db.from(target.table).update({ row_data: next }).eq("id", target.id).filter(filterColumn, "is", null);
  if (target.subjectId) update = update.eq("row_data->>residentUserId", target.subjectId);
  const { data: updated, error: updateError } = await update.select("id");
  if (updateError) throw new Error("Could not save your check-in.");
  if ((updated ?? []).length === 0) {
    // Someone else's tap won the race: read what they wrote.
    const { data: again } = await db.from(target.table).select("row_data").eq("id", target.id).maybeSingle();
    const raw = ((again as { row_data?: Record<string, unknown> } | null)?.row_data ?? {}) as Record<string, unknown>;
    if (target.subjectId && raw.residentUserId !== target.subjectId) throw new Error("Move-in no longer belongs to this account.");
    const source = (target.path === "stayDetails" ? raw.stayDetails ?? {} : raw) as Record<string, unknown>;
    return { stamped: false, existing: typeof source.checkedInAt === "string" ? source.checkedInAt : atIso };
  }
  return { stamped: true, existing: null };
}

async function unstamp(db: SupabaseClient, target: StampTarget, atIso: string): Promise<void> {
  try {
    const { data } = await db.from(target.table).select("row_data").eq("id", target.id).maybeSingle();
    const rowData = ((data as { row_data?: unknown } | null)?.row_data ?? {}) as Record<string, unknown>;
    if (target.subjectId && rowData.residentUserId !== target.subjectId) return;
    if (target.path === "stayDetails") {
      const details = { ...((rowData.stayDetails ?? {}) as Record<string, unknown>) };
      if (details.checkedInAt !== atIso) return;
      delete details.checkedInAt;
      await db.from(target.table).update({ row_data: { ...rowData, stayDetails: details } }).eq("id", target.id);
    } else {
      if (rowData.checkedInAt !== atIso) return;
      const { checkedInAt: _drop, ...rest } = rowData;
      void _drop;
      await db.from(target.table).update({ row_data: rest }).eq("id", target.id);
    }
  } catch {
    /* best effort: a stuck stamp only means the notice is not retried */
  }
}

export async function recordResidentCheckIn(
  db: SupabaseClient,
  input: { userId: string; email: string; key: CheckInKey; now?: Date },
): Promise<RecordCheckInResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const eventKey = `${RESIDENT_CHECKED_IN_EVENT}:${input.key.kind}:${input.key.id}`;

  let managerUserId = "";
  let propertyId = "";
  let residentName = "";
  let propertyLabel = "";
  let roomLabel = "";
  let target: StampTarget;

  if (input.key.kind === "stay") {
    const stay = await loadStayCheckIn(db, input.userId, input.key.id, now);
    if (!stay) return { ok: false, status: 404, error: "Stay not found." };
    if (!stay.reveal.revealed) return { ok: false, status: 403, error: "Check-in opens 24 hours before your stay." };
    managerUserId = stay.managerUserId;
    propertyId = stay.propertyId;
    residentName = stay.guestName;
    propertyLabel = stay.propertyLabel;
    roomLabel = stay.roomLabel;
    target = { table: "portal_schedule_records", id: input.key.id, path: "stayDetails" };
  } else {
    const context = await loadTenancyCheckInContext(db, input.email, { residentUserId: input.userId });
    if (!context || context.recordId !== input.key.id) return { ok: false, status: 404, error: "Move-in not found." };
    const leaseUnlocked =
      (await loadResidentLeaseSignedStatus(input.email, context.managerUserId, input.userId)) ||
      (await loadResidentManagerAttestedTenancy(input.email, context.managerUserId, input.userId));
    const reveal = tenancyReveal(context, leaseUnlocked, now);
    if (!reveal.revealed) return { ok: false, status: 403, error: "Check-in opens 24 hours before your move-in." };
    managerUserId = context.managerUserId;
    propertyId = context.propertyId ?? "";
    const resolved = await loadResidentMoveInForEmail(input.email, { db, managerUserId, residentUserId: input.userId });
    propertyLabel = resolved?.propertyLabel ?? "";
    roomLabel = resolved?.roomLabel && !/^not assigned/i.test(resolved.roomLabel) ? resolved.roomLabel : "";
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", input.userId).maybeSingle();
    residentName = String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim();
    target = { table: "manager_application_records", id: context.recordId, path: "root", subjectId: input.userId };
  }

  const { stamped, existing } = await stampCheckedIn(db, target, nowIso);
  if (!stamped) return { ok: true, checkedInAt: existing ?? nowIso, alreadyCheckedIn: true };

  try {
    const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
    const senderEmail = String((manager as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();
    const text = checkedInNoticeText({ residentName, propertyLabel, roomLabel });
    const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings`;
    await emitActionEvent(db, {
      eventId: eventKey,
      domain: "channel_booking",
      event: RESIDENT_CHECKED_IN_EVENT,
      managerUserId,
      entityId: input.key.id,
      category: "leases",
      senderUserId: managerUserId,
      senderEmail,
      senderName: String((manager as { full_name?: unknown } | null)?.full_name ?? "").trim() || undefined,
      payload: { propertyId, checkInKey: `${input.key.kind}:${input.key.id}` },
      templateContext: { residentName, propertyTitle: propertyLabel, roomLabel, url },
      recipients: [{ audience: "manager", userId: managerUserId, rendered: { subject: "Checked in", text, smsText: text } }],
    });
  } catch (error) {
    // The tap must be retryable if the notice did not go: give the stamp back.
    await unstamp(db, target, nowIso);
    return { ok: false, status: 500, error: error instanceof Error ? error.message : "Could not notify your manager." };
  }
  return { ok: true, checkedInAt: nowIso, alreadyCheckedIn: false };
}
