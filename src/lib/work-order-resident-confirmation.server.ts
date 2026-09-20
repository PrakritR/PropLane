import "server-only";

/**
 * "Was this fixed?" — the resident's confirmation step after a vendor marks a
 * job done (PLAN-0915).
 *
 * Before this the resident was told "Reply YES or NO" and nothing handled the
 * reply. Now the completion message carries a signed link (works for every
 * manager, with or without a work number) and the SMS keywords route here too.
 *
 * The token is opaque and only its SHA-256 is stored on the row, the same
 * pattern as co-manager invites, so the link is unguessable and can be
 * invalidated by re-asking. Silence closes the question after the manager's
 * chosen number of hours (`autoCloseResidentConfirmations`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { resolveServiceAutomationSettingsForRow } from "@/lib/service-automation-settings.server";
import { createSettingsScopeCache } from "@/lib/settings/scope-resolver.server";
import { workOrderEvent, type WorkOrderEventRecipient } from "@/lib/work-order-events.server";

export const RESIDENT_CONFIRMATION_PATH = "/services/confirm";

/** Seven days: a resident should not be able to reopen a job from a month-old email. */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function residentConfirmationUrl(token: string): string {
  return `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}${RESIDENT_CONFIRMATION_PATH}?t=${encodeURIComponent(token)}`;
}

type Actor = { userId: string; email: string; fullName?: string };

type WorkOrderRecord = {
  id: string;
  manager_user_id: string;
  vendor_user_id: string | null;
  row_data: DemoManagerWorkOrderRow;
};

async function managerRecipients(db: SupabaseClient, record: WorkOrderRecord): Promise<WorkOrderEventRecipient[]> {
  const ids = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: record.manager_user_id,
    propertyId: record.row_data.assignedPropertyId || record.row_data.propertyId || undefined,
    channel: "services",
  });
  return ids.map((userId) => ({ audience: "manager" as const, userId }));
}

/**
 * Stamp a fresh confirmation request on the row and return the link to put in
 * the resident's message. Returns null when the manager has the step off.
 */
export async function requestResidentConfirmation(
  db: SupabaseClient,
  workOrderId: string,
  managerUserId: string,
  rowData: DemoManagerWorkOrderRow,
  now: Date = new Date(),
): Promise<{ rowData: DemoManagerWorkOrderRow; confirmUrl: string } | null> {
  // A house with its own service automation settings gets them; a work order
  // with no property, or an un-customized house, falls through workspace then
  // account (phase C).
  const propertyId = rowData.assignedPropertyId || rowData.propertyId || null;
  const settings = await resolveServiceAutomationSettingsForRow(db, createSettingsScopeCache(), managerUserId, propertyId).catch(() => null);
  if (!settings?.residentConfirmation) return null;
  if (!(rowData.residentEmail ?? "").includes("@")) return null;
  const token = randomBytes(24).toString("base64url");
  const next: DemoManagerWorkOrderRow = {
    ...rowData,
    residentConfirmation: { requestedAt: now.toISOString(), tokenId: hashToken(token) },
  };
  await db.from("portal_work_order_records").update({ row_data: next, updated_at: now.toISOString() }).eq("id", workOrderId);
  return { rowData: next, confirmUrl: residentConfirmationUrl(token) };
}

async function findByToken(db: SupabaseClient, token: string): Promise<WorkOrderRecord | null> {
  const tokenId = hashToken(token);
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .contains("row_data", { residentConfirmation: { tokenId } })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return data as unknown as WorkOrderRecord;
}

export type ConfirmationLookup =
  | { ok: true; workOrder: { id: string; title: string; propertyLabel: string; vendorName: string; verdict?: string; rating?: number } }
  | { ok: false; reason: "invalid" | "expired" };

/** What the public confirmation page shows before the resident answers. */
export async function lookupResidentConfirmation(db: SupabaseClient, token: string): Promise<ConfirmationLookup> {
  const record = await findByToken(db, token);
  const confirmation = record?.row_data.residentConfirmation;
  if (!record || !confirmation) return { ok: false, reason: "invalid" };
  if (Date.parse(confirmation.requestedAt) + TOKEN_TTL_MS < Date.now()) return { ok: false, reason: "expired" };
  return {
    ok: true,
    workOrder: {
      id: record.id,
      title: record.row_data.title || "Service",
      propertyLabel: record.row_data.propertyName || "",
      vendorName: record.row_data.vendorName || record.row_data.assignee?.name || "The vendor",
      verdict: confirmation.verdict,
      rating: confirmation.rating,
    },
  };
}

async function senderFor(db: SupabaseClient, managerUserId: string): Promise<Actor> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
  return {
    userId: managerUserId,
    email: String(data?.email ?? "").trim().toLowerCase(),
    fullName: String(data?.full_name ?? "").trim() || "PropLane Portal",
  };
}

/**
 * Record the resident's answer. "Fixed" closes the question and offers a
 * rating; "not fixed" reopens the job for the vendor and tells everyone.
 */
export async function resolveResidentConfirmation(
  db: SupabaseClient,
  input: { token: string; verdict: "fixed" | "not_fixed"; note?: string; now?: Date },
): Promise<{ ok: true; ratingUrl: string | null } | { ok: false; reason: "invalid" | "expired" | "answered" }> {
  const record = await findByToken(db, input.token);
  return resolveConfirmationRecord(db, record, { ...input, ratingUrl: residentConfirmationUrl(input.token) });
}

/**
 * The SMS path: a resident texting YES / NO answers the newest open question
 * on any of their work orders under this manager. Returns null when there is
 * nothing open, so the caller can fall through to ordinary intent handling.
 */
export async function resolveResidentConfirmationBySms(
  db: SupabaseClient,
  input: { managerUserId: string; residentEmail: string; verdict: "fixed" | "not_fixed"; note?: string; now?: Date },
): Promise<{ ok: true; title: string; reopened: boolean } | null> {
  const email = input.residentEmail.trim().toLowerCase();
  if (!email.includes("@")) return null;
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data, updated_at")
    .eq("manager_user_id", input.managerUserId)
    .eq("resident_email", email)
    .not("row_data->residentConfirmation", "is", null)
    .order("updated_at", { ascending: false })
    .limit(20);
  const record = ((data ?? []) as unknown as WorkOrderRecord[]).find(
    (candidate) => candidate.row_data.residentConfirmation && !candidate.row_data.residentConfirmation.respondedAt,
  );
  if (!record) return null;
  const result = await resolveConfirmationRecord(db, record, { verdict: input.verdict, note: input.note, now: input.now, ratingUrl: null });
  if (!result.ok) return null;
  return { ok: true, title: record.row_data.title || "your service request", reopened: input.verdict === "not_fixed" };
}

async function resolveConfirmationRecord(
  db: SupabaseClient,
  record: WorkOrderRecord | null,
  input: { verdict: "fixed" | "not_fixed"; note?: string; now?: Date; ratingUrl: string | null },
): Promise<{ ok: true; ratingUrl: string | null } | { ok: false; reason: "invalid" | "expired" | "answered" }> {
  const now = input.now ?? new Date();
  const confirmation = record?.row_data.residentConfirmation;
  if (!record || !confirmation) return { ok: false, reason: "invalid" };
  if (Date.parse(confirmation.requestedAt) + TOKEN_TTL_MS < now.getTime()) return { ok: false, reason: "expired" };
  if (confirmation.respondedAt) return { ok: false, reason: "answered" };

  const note = String(input.note ?? "").trim().slice(0, 500) || undefined;
  const nextConfirmation = { ...confirmation, respondedAt: now.toISOString(), verdict: input.verdict, ...(note ? { note } : {}) };
  const reopened = input.verdict === "not_fixed";
  const next: DemoManagerWorkOrderRow = {
    ...record.row_data,
    residentConfirmation: nextConfirmation,
    // Reopening hands the job back to the vendor: their "done" no longer
    // stands, so the invoice nudge and the manager's approval step both wait.
    ...(reopened ? { automationStatus: undefined, vendorMarkedDoneAt: undefined, reopenedAt: now.toISOString() } : {}),
  };
  await db.from("portal_work_order_records").update({ row_data: next, updated_at: now.toISOString() }).eq("id", record.id);

  const sender = await senderFor(db, record.manager_user_id);
  const residentEmail = (record.row_data.residentEmail ?? "").trim();
  const facts = {
    reference: record.row_data.reference || "Work order",
    title: record.row_data.title || "Service",
    propertyLabel: record.row_data.propertyName || undefined,
    vendorName: record.row_data.vendorName || record.row_data.assignee?.name || undefined,
    residentName: record.row_data.residentName || undefined,
    note,
    ratingUrl: reopened ? undefined : input.ratingUrl ?? undefined,
    url: `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/services/work-orders`,
  };
  const managers = await managerRecipients(db, record);
  await workOrderEvent(db, {
    eventId: `${record.id}:${reopened ? "resident_reopened" : "resident_confirmed"}:${confirmation.requestedAt}`,
    event: reopened ? "resident_reopened" : "resident_confirmed",
    managerUserId: record.manager_user_id,
    workOrderId: record.id,
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.fullName,
    facts,
    recipients: [
      ...(residentEmail.includes("@") ? [{ audience: "resident" as const, email: residentEmail }] : []),
      ...managers,
      ...(reopened && record.vendor_user_id ? [{ audience: "vendor" as const, userId: record.vendor_user_id }] : []),
    ],
    now,
  }).catch(() => undefined);

  return { ok: true, ratingUrl: reopened ? null : facts.ratingUrl ?? null };
}

/** The resident's star rating after confirming the fix; relayed to the vendor only when the manager shares ratings. */
export async function rateResidentConfirmation(
  db: SupabaseClient,
  input: { token: string; rating: number; note?: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" | "unconfirmed" | "rated" }> {
  const now = input.now ?? new Date();
  const record = await findByToken(db, input.token);
  const confirmation = record?.row_data.residentConfirmation;
  if (!record || !confirmation) return { ok: false, reason: "invalid" };
  if (Date.parse(confirmation.requestedAt) + TOKEN_TTL_MS < now.getTime()) return { ok: false, reason: "expired" };
  if (confirmation.verdict !== "fixed") return { ok: false, reason: "unconfirmed" };
  if (typeof confirmation.rating === "number") return { ok: false, reason: "rated" };
  const rating = Math.max(1, Math.min(5, Math.round(input.rating)));
  const note = String(input.note ?? "").trim().slice(0, 500) || undefined;
  const next: DemoManagerWorkOrderRow = {
    ...record.row_data,
    residentConfirmation: { ...confirmation, rating, ratedAt: now.toISOString(), ...(note ? { note } : {}) },
  };
  await db.from("portal_work_order_records").update({ row_data: next, updated_at: now.toISOString() }).eq("id", record.id);

  // A house with its own service automation settings gets them; a work order
  // with no property, or an un-customized house, falls through workspace then
  // account (phase C).
  const ratedPropertyId = record.row_data.assignedPropertyId || record.row_data.propertyId || null;
  const settings = await resolveServiceAutomationSettingsForRow(db, createSettingsScopeCache(), record.manager_user_id, ratedPropertyId).catch(() => null);
  const sender = await senderFor(db, record.manager_user_id);
  const managers = await managerRecipients(db, record);
  await workOrderEvent(db, {
    eventId: `${record.id}:rated:${confirmation.requestedAt}`,
    event: "rated",
    managerUserId: record.manager_user_id,
    workOrderId: record.id,
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.fullName,
    facts: {
      reference: record.row_data.reference || "Work order",
      title: record.row_data.title || "Service",
      propertyLabel: record.row_data.propertyName || undefined,
      vendorName: record.row_data.vendorName || record.row_data.assignee?.name || undefined,
      residentName: record.row_data.residentName || undefined,
      rating,
      note,
    },
    recipients: [
      ...managers,
      ...(settings?.shareRatingsWithVendors && record.vendor_user_id ? [{ audience: "vendor" as const, userId: record.vendor_user_id }] : []),
    ],
    now,
  }).catch(() => undefined);
  return { ok: true };
}

/**
 * Silence is an answer: after the manager's `autoCloseHours`, an unanswered
 * confirmation closes itself and the resident is told once. Idempotent — a
 * closed question is never asked or closed twice.
 */
export async function autoCloseResidentConfirmations(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .not("row_data->residentConfirmation", "is", null)
    .limit(500);
  if (error) throw error;
  const open = ((data ?? []) as unknown as WorkOrderRecord[]).filter(
    (record) => record.row_data.residentConfirmation && !record.row_data.residentConfirmation.respondedAt,
  );
  if (open.length === 0) return 0;
  let closed = 0;
  const settingsCache = createSettingsScopeCache();
  for (const record of open) {
    // A house with its own service automation settings gets them; a work order
    // with no property, or an un-customized house, falls through workspace then
    // account (phase C).
    const propertyId = record.row_data.assignedPropertyId || record.row_data.propertyId || null;
    const settings = await resolveServiceAutomationSettingsForRow(db, settingsCache, record.manager_user_id, propertyId).catch(() => null);
    if (!settings || !settings.autoCloseHours) continue;
    const confirmation = record.row_data.residentConfirmation!;
    const dueMs = Date.parse(confirmation.requestedAt) + settings.autoCloseHours * 60 * 60_000;
    if (!Number.isFinite(dueMs) || dueMs > now.getTime()) continue;
    const next: DemoManagerWorkOrderRow = {
      ...record.row_data,
      residentConfirmation: { ...confirmation, respondedAt: now.toISOString(), verdict: "auto_closed" },
    };
    const { data: updated } = await db
      .from("portal_work_order_records")
      .update({ row_data: next, updated_at: now.toISOString() })
      .eq("id", record.id)
      .contains("row_data", { residentConfirmation: { tokenId: confirmation.tokenId } })
      .select("id")
      .maybeSingle();
    if (!updated) continue;
    closed += 1;
    const residentEmail = (record.row_data.residentEmail ?? "").trim();
    if (!residentEmail.includes("@")) continue;
    const sender = await senderFor(db, record.manager_user_id);
    await workOrderEvent(db, {
      eventId: `${record.id}:auto_closed:${confirmation.requestedAt}`,
      event: "auto_closed",
      managerUserId: record.manager_user_id,
      workOrderId: record.id,
      senderUserId: sender.userId,
      senderEmail: sender.email,
      senderName: sender.fullName,
      facts: { reference: record.row_data.reference || "Work order", title: record.row_data.title || "Service", propertyLabel: record.row_data.propertyName || undefined },
      recipients: [{ audience: "resident", email: residentEmail }],
      now,
    }).catch(() => undefined);
  }
  return closed;
}
