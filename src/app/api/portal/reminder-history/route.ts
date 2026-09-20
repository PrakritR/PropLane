/**
 * Manager reminder Sent history — a read-only log over the reminder spine's
 * single queue table.
 *
 * There is no separate history table: `portal_reminder_records` is both the
 * pending queue and the sent/failed history, and a row transitions `status`
 * in place (`scheduled -> sending -> sent|failed`, or `cancelled`). See
 * `supabase/migrations/20260830020000_reminder_queue.sql` and
 * `supabase/migrations/20260912220000_tour_interest_reminders.sql`.
 * `public.resolve_reminder(...)` is what stamps `status` / `sent_at` /
 * `last_error`.
 *
 * SECURITY: `manager_user_id` comes ONLY from the authenticated session via
 * `requireManagerRouteUser`. A `managerUserId` (or any owner-like value) in
 * the query string is never read, never validated — it is simply not part of
 * this handler's vocabulary. That is the whole security property of this
 * endpoint: a caller cannot widen or redirect the scope by passing one.
 *
 * `last_error` is rendered VERBATIM. It is written by the dispatcher
 * (`src/lib/reminders/dispatch.server.ts`, `public.resolve_reminder`) and is
 * the only diagnostic a manager will ever get for a failed send. Never
 * reword it, map it to a friendlier message, or substitute a generic
 * "something went wrong" — that would discard the only evidence available.
 *
 * Read-only: GET only. No mutation route, no retry, no delete lives here.
 *
 * This is a co-manager-unscoped read: it follows the exact same guard as the
 * sibling `/api/portal/reminder-settings` route (plain manager-role check,
 * no co-manager module permission), because a reminder can be about nearly
 * every module (tours, leases, payments, services, applications, ...) and no
 * single `CoManagerPermissionId` in `src/lib/co-manager-permissions.ts`
 * covers "notifications sent across modules". If a co-manager notification
 * log ever needs narrower scoping, tighten this alongside
 * `/api/portal/reminder-settings` rather than inventing a one-off permission
 * key here.
 */
import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { REMINDER_SUBJECT_KINDS, type ReminderSubjectKind } from "@/lib/reminders/rules";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";

export const runtime = "nodejs";

const STATUS_VALUES = ["scheduled", "sending", "sent", "failed", "cancelled"] as const;
type ReminderStatus = (typeof STATUS_VALUES)[number];

/**
 * Display labels for a single history row. Product copy says "service",
 * never "work order" — `work_order` renders as "Service visit" here. The
 * schema `kind` value is untouched; this is a display-only map
 * (`tests/unit/services-vocabulary.test.ts` guards the rendered-copy side of
 * that split, but this file is `.ts`, not `.tsx`, and is out of that scan's
 * scope regardless).
 */
const KIND_LABELS: Record<ReminderSubjectKind, string> = {
  tour: "Tour",
  tour_interest: "Tour interest follow-up",
  task: "Task",
  service_order: "Service request",
  work_order: "Service visit",
  application: "Application",
  application_manager: "Application alert",
  application_post_tour: "Post-tour follow-up",
  lease: "Lease",
  lease_manager: "Lease alert",
  payment_manager: "Payment alert",
  outgoing_payment: "Outgoing payment",
  booking: "Booking",
  inspection: "Room photos",
  inspection_manager: "Missing room photos",
  work_order_unassigned: "Unassigned escalation",
  work_order_unassigned_emergency: "Emergency escalation",
  work_order_no_on_my_way: "On my way missing",
  vendor_offer_expiry: "Offer expiring",
  vendor_invoice_nudge: "Invoice nudge",
  invoice_approval: "Invoice approval",
  service_request_decision: "Add-on decision",
  service_request_unpaid: "Add-on unpaid",
  vendor_document_expiry: "Vendor document expiry",
  lease_ending: "Lease ending",
  lease_ending_manager: "Lease ending alert",
  renewal_offer_expiry: "Renewal offer expiry",
  countersign_overdue: "Countersignature overdue",
  move_in: "Move-in",
  move_in_payment_method: "Payment method missing",
  move_out: "Move-out",
  move_out_inspection_manager: "Move-out inspection",
  deposit_accounting: "Deposit accounting",
  lease_renewal_offer: "Renewal offer",
  move_out_instructions: "Move-out instructions",
  deposit_return_notice: "Deposit return notice",
  application_documents: "Documents requested",
  application_decision_manager: "Decision reminder",
  application_no_lease_manager: "Approved, no lease",
  cosigner: "Cosigner reminder",
  group_application: "Group application",
  tour_request_unanswered: "Tour request unanswered",
  tour_request_reoffer: "Tour re-offer",
  tour_no_show_manager: "No-show prompt",
  tour_feedback: "Tour feedback",
  delinquency_manager: "Delinquency",
  message_unanswered: "Unanswered message",
  document_signature: "Signature reminder",
  task_overdue: "Task overdue",
  resident_welcome: "Welcome",
  inspection_acknowledge: "Inspection acknowledge",
};

const DEFAULT_LIMIT = 25;
/** A busy workspace can have thousands of rows; never hand back an unbounded list. */
const MAX_LIMIT = 100;

export type ReminderHistoryItem = {
  id: string;
  kind: ReminderSubjectKind;
  kindLabel: string;
  status: ReminderStatus;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientRole: "manager" | "counterparty";
  /** Derived, not stored: a row carries a phone only when it was sent by SMS. */
  channel: "email" | "sms";
  sendAt: string;
  sendAtLabel: string;
  sentAt: string | null;
  sentAtLabel: string | null;
  lastError: string | null;
  attempts: number;
};

type RawRow = {
  id: string;
  kind: string;
  status: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  recipient_role: string | null;
  send_at: string;
  sent_at: string | null;
  last_error: string | null;
  attempts: number | null;
  created_at: string;
};

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function parseOffset(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function toLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatInboxStamp(d);
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);

    const limit = clampLimit(url.searchParams.get("limit"));
    const offset = parseOffset(url.searchParams.get("cursor") ?? url.searchParams.get("offset"));

    const statusParam = url.searchParams.get("status");
    if (statusParam !== null && !STATUS_VALUES.includes(statusParam as ReminderStatus)) {
      return NextResponse.json({ error: "Unknown status filter." }, { status: 400 });
    }
    const kindParam = url.searchParams.get("kind");
    if (kindParam !== null && !REMINDER_SUBJECT_KINDS.includes(kindParam as ReminderSubjectKind)) {
      return NextResponse.json({ error: "Unknown kind filter." }, { status: 400 });
    }

    // Fetch one extra row to detect a next page without a second count query.
    let query = ctx.db
      .from("portal_reminder_records")
      .select(
        "id, kind, status, recipient_email, recipient_phone, recipient_role, send_at, sent_at, last_error, attempts, created_at",
      )
      .eq("manager_user_id", ctx.userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit);

    if (statusParam) query = query.eq("status", statusParam);
    if (kindParam) query = query.eq("kind", kindParam);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: "Failed to load reminder history." }, { status: 500 });
    }

    const rows = (data ?? []) as RawRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items: ReminderHistoryItem[] = page.map((row) => {
      const kind = REMINDER_SUBJECT_KINDS.includes(row.kind as ReminderSubjectKind)
        ? (row.kind as ReminderSubjectKind)
        : ("task" as ReminderSubjectKind);
      const recipientPhone = row.recipient_phone ?? null;
      return {
        id: String(row.id),
        kind,
        kindLabel: KIND_LABELS[kind] ?? row.kind,
        status: (STATUS_VALUES.includes(row.status as ReminderStatus) ? row.status : "scheduled") as ReminderStatus,
        recipientEmail: row.recipient_email ?? null,
        recipientPhone,
        recipientRole: row.recipient_role === "manager" ? "manager" : "counterparty",
        channel: recipientPhone ? "sms" : "email",
        sendAt: row.send_at,
        sendAtLabel: toLabel(row.send_at) ?? row.send_at,
        sentAt: row.sent_at ?? null,
        sentAtLabel: toLabel(row.sent_at),
        // Verbatim. Do not reword, truncate, or discard — see file header.
        lastError: row.last_error ?? null,
        attempts: typeof row.attempts === "number" ? row.attempts : 0,
      };
    });

    return NextResponse.json({
      items,
      nextCursor: hasMore ? String(offset + limit) : null,
      smsUiEnabled: isSmsCommUiEnabled(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
