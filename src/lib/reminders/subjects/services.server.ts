/**
 * Services → the reminder queue: escalations and the vendor loop (PLAN-0915).
 *
 * Every sweep here is anchored on a moment that already exists on the row —
 * when a request was filed, when an offer expires, when the vendor marked it
 * done, when an invoice arrived — and materialises through the same
 * `materializeReminders` as every other subject, so dedupe, quiet hours and
 * the manager's audience choices are inherited rather than reimplemented.
 *
 * Bounded like `records.server.ts`: one capped read per table per tick, the
 * window applied in JS. These tables are small per manager; if one grows,
 * promote the anchor to a column and filter in SQL.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { materializeReminders, type ReminderRecipient } from "@/lib/reminders/queue.server";
import type { ReminderSettings, ReminderSubjectKind } from "@/lib/reminders/rules";
import {
  createSettingsScopeCache,
  resolveReminderSettingsForRow,
} from "@/lib/reminders/settings.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { resolveServiceAutomationSettingsForRow } from "@/lib/service-automation-settings.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { VENDOR_DOCUMENT_LABELS, type VendorDocumentRecord } from "@/lib/vendor-documents";
import { isoOrNull } from "@/lib/reminders/subjects/records.server";

const MAX_ROWS = 500;
/** Anchors older than this are history, not something to chase. */
const MAX_AGE_DAYS = 45;

type WorkOrderDbRow = {
  id: string;
  manager_user_id: string;
  resident_email: string | null;
  created_at: string;
  row_data: DemoManagerWorkOrderRow;
};

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function withinAge(anchorIso: string, now: Date, maxAgeDays = MAX_AGE_DAYS): boolean {
  const ms = Date.parse(anchorIso);
  return Number.isFinite(ms) && now.getTime() - ms <= maxAgeDays * 24 * 60 * 60_000 && ms <= now.getTime() + 120 * 24 * 60 * 60_000;
}

function origin(): string {
  return resolveEmailLinkBaseUrl().replace(/\/$/, "");
}

async function managerSideRecipients(
  db: SupabaseClient,
  managerUserId: string,
  kind: ReminderSubjectKind,
  settings: ReminderSettings,
  managerRecipients: Map<string, { email: string; name: string | null }>,
  propertyId: string | null,
): Promise<ReminderRecipient[]> {
  const rule = settings.rules[kind];
  const out: ReminderRecipient[] = [];
  const manager = managerRecipients.get(managerUserId);
  if (manager) out.push({ email: manager.email, role: "manager", name: manager.name, userId: managerUserId });
  if (rule.audience.team) {
    out.push(
      ...teamReminderRecipients(
        await loadTeamReminderRecipients(db, managerUserId, rule.teamUserIds ?? [], {
          module: REMINDER_SUBJECT_CO_MANAGER_MODULE[kind],
          propertyId,
        }),
      ),
    );
  }
  return out;
}

async function loadOpenWorkOrders(db: SupabaseClient): Promise<WorkOrderDbRow[]> {
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, resident_email, created_at, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []).filter(
    (row): row is WorkOrderDbRow =>
      typeof (row as { manager_user_id?: unknown }).manager_user_id === "string" && Boolean((row as { row_data?: unknown }).row_data),
  );
}

function isUnassigned(row: DemoManagerWorkOrderRow): boolean {
  return row.bucket === "open" && !row.vendorId && !row.vendorUserId && !row.assignee && !row.selfAssigned;
}

/**
 * `work_order_unassigned` / `work_order_unassigned_emergency` — the manager
 * (and team) told that a request has sat with nobody on it. Anchored on the
 * row's `created_at`; the emergency kind is URGENT and skips quiet hours.
 */
export async function sweepWorkOrderEscalations(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = (await loadOpenWorkOrders(db)).filter((row) => isUnassigned(row.row_data));
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => row.manager_user_id);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const row of rows) {
    const emergency = row.row_data.priority === "Emergency";
    const kind: ReminderSubjectKind = emergency ? "work_order_unassigned_emergency" : "work_order_unassigned";
    const propertyId = row.row_data.assignedPropertyId || row.row_data.propertyId || null;
    // A house with its own reminder rules gets them; a request with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, propertyId);
    if (!settings.rules[kind].enabled) continue;
    const anchorIso = isoOrNull(row.created_at);
    if (!anchorIso || !withinAge(anchorIso, now)) continue;
    const recipients = await managerSideRecipients(db, row.manager_user_id, kind, settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind,
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: {
          title: row.row_data.title,
          propertyLabel: row.row_data.propertyName,
          counterpartyName: row.row_data.residentName,
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/portal/services/work-orders`,
          notificationCategory: "maintenance",
          emergency,
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/**
 * `work_order_no_on_my_way` — when the manager requires vendors to tap On my
 * way and the visit window has opened without it. Anchored on the visit.
 */
export async function sweepWorkOrderNoOnMyWay(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = (await loadOpenWorkOrders(db)).filter(
    (row) => row.row_data.bucket === "scheduled" && !row.row_data.enRouteAt && isoOrNull(row.row_data.scheduledAtIso),
  );
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => row.manager_user_id);
  const cache = createSettingsScopeCache();
  const serviceCache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const row of rows) {
    const propertyId = row.row_data.assignedPropertyId || row.row_data.propertyId || null;
    // A house with its own reminder rules gets them; a request with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, propertyId);
    if (!settings.rules.work_order_no_on_my_way.enabled) continue;
    // Same fallback for the `serviceAutomation` namespace's `requireOnMyWay` gate.
    const serviceSettings = await resolveServiceAutomationSettingsForRow(db, serviceCache, row.manager_user_id, propertyId);
    if (!serviceSettings.requireOnMyWay) continue;
    const anchorIso = isoOrNull(row.row_data.scheduledAtIso)!;
    if (!withinAge(anchorIso, now, 7)) continue;
    const recipients = await managerSideRecipients(db, row.manager_user_id, "work_order_no_on_my_way", settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind: "work_order_no_on_my_way",
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: {
          title: row.row_data.title,
          propertyLabel: row.row_data.propertyName,
          counterpartyName: row.row_data.vendorName || row.row_data.assignee?.name || "The vendor",
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/portal/services/work-orders`,
          notificationCategory: "maintenance",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

type OfferRow = {
  id: string;
  work_order_id: string;
  vendor_directory_id: string;
  vendor_user_id: string | null;
  manager_user_id: string;
  status: string;
  expires_at: string | null;
};

/**
 * `vendor_offer_expiry` — the vendor nudged before an unanswered offer expires.
 * Anchored on `expires_at`; the offer's own expiry action lives in
 * `services-automation-sweeps.server.ts`.
 */
export async function sweepVendorOfferExpiry(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("work_order_vendor_offers")
    .select("id, work_order_id, vendor_directory_id, vendor_user_id, manager_user_id, status, expires_at")
    .eq("status", "sent")
    .not("expires_at", "is", null)
    .gte("expires_at", now.toISOString())
    .limit(MAX_ROWS);
  if (error) throw error;
  const offers = (data ?? []) as OfferRow[];
  if (offers.length === 0) return 0;
  const cache = createSettingsScopeCache();
  const workOrderIds = [...new Set(offers.map((offer) => offer.work_order_id))];
  const { data: workOrders } = await db.from("portal_work_order_records").select("id, row_data").in("id", workOrderIds);
  const workOrderById = new Map<string, DemoManagerWorkOrderRow>();
  for (const row of workOrders ?? []) workOrderById.set(String(row.id), row.row_data as DemoManagerWorkOrderRow);
  const vendorIds = [...new Set(offers.map((offer) => offer.vendor_directory_id))];
  const { data: vendors } = await db.from("manager_vendor_records").select("id, row_data").in("id", vendorIds);
  const vendorById = new Map<string, { email: string; name: string }>();
  for (const row of vendors ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    vendorById.set(String(row.id), {
      email: String(rowData.email ?? "").trim().toLowerCase(),
      name: String(rowData.name ?? "").trim(),
    });
  }
  let queued = 0;
  for (const offer of offers) {
    const workOrder = workOrderById.get(offer.work_order_id);
    if (!workOrder || workOrder.bucket === "completed") continue;
    const propertyId = workOrder.assignedPropertyId || workOrder.propertyId || null;
    // A house with its own reminder rules gets them; an offer with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, offer.manager_user_id, propertyId);
    if (!settings.rules.vendor_offer_expiry.enabled) continue;
    const vendor = vendorById.get(offer.vendor_directory_id);
    if (!vendor?.email.includes("@")) continue;
    const anchorIso = isoOrNull(offer.expires_at);
    if (!anchorIso) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: offer.manager_user_id,
        kind: "vendor_offer_expiry",
        subjectId: offer.id,
        anchorIso,
        recipients: [{ email: vendor.email, role: "vendor", name: vendor.name, userId: offer.vendor_user_id }],
        payload: {
          title: workOrder.title,
          propertyLabel: workOrder.propertyName,
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/vendor/work-orders`,
          notificationCategory: "maintenance",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/**
 * `vendor_invoice_nudge` — a vendor who marked the job done but has not
 * invoiced. Anchored on `vendorMarkedDoneAt`; cancelled by the currency check
 * the moment an invoice for the work order exists.
 */
export async function sweepVendorInvoiceNudge(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = (await loadOpenWorkOrders(db)).filter(
    (row) => row.row_data.automationStatus === "vendor_marked_done" && isoOrNull(row.row_data.vendorMarkedDoneAt) && row.row_data.vendorUserId,
  );
  if (rows.length === 0) return 0;
  const cache = createSettingsScopeCache();
  const vendorIds = [...new Set(rows.map((row) => String(row.row_data.vendorUserId)))];
  const { data: profiles } = await db.from("profiles").select("id, email, full_name").in("id", vendorIds);
  const vendorById = new Map<string, { email: string; name: string }>();
  for (const row of profiles ?? []) {
    vendorById.set(String(row.id), { email: String(row.email ?? "").trim().toLowerCase(), name: String(row.full_name ?? "").trim() });
  }
  let queued = 0;
  for (const row of rows) {
    const propertyId = row.row_data.assignedPropertyId || row.row_data.propertyId || null;
    // A house with its own reminder rules gets them; a work order with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, propertyId);
    if (!settings.rules.vendor_invoice_nudge.enabled) continue;
    const vendor = vendorById.get(String(row.row_data.vendorUserId));
    if (!vendor?.email.includes("@")) continue;
    const anchorIso = isoOrNull(row.row_data.vendorMarkedDoneAt)!;
    if (!withinAge(anchorIso, now)) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind: "vendor_invoice_nudge",
        subjectId: row.id,
        anchorIso,
        recipients: [{ email: vendor.email, role: "vendor", name: vendor.name, userId: String(row.row_data.vendorUserId) }],
        payload: {
          title: row.row_data.title,
          propertyLabel: row.row_data.propertyName,
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/vendor/financials/invoices`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** `invoice_approval` — a submitted vendor invoice the manager has not decided. */
export async function sweepInvoiceApproval(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("vendor_invoices")
    .select("id, manager_user_id, vendor_user_id, work_order_id, total_cents, submitted_at")
    .eq("status", "submitted")
    .limit(MAX_ROWS);
  if (error) throw error;
  const invoices = data ?? [];
  if (invoices.length === 0) return 0;
  const managerIds = invoices.map((invoice) => String(invoice.manager_user_id));
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  const vendorIds = [...new Set(invoices.map((invoice) => String(invoice.vendor_user_id)))];
  const { data: profiles } = await db.from("profiles").select("id, full_name").in("id", vendorIds);
  const vendorName = new Map<string, string>();
  for (const row of profiles ?? []) vendorName.set(String(row.id), String(row.full_name ?? "").trim());
  const workOrderIds = [...new Set(invoices.map((invoice) => String(invoice.work_order_id ?? "")).filter(Boolean))];
  const { data: invoiceWorkOrders } = workOrderIds.length
    ? await db.from("portal_work_order_records").select("id, row_data").in("id", workOrderIds)
    : { data: [] };
  const workOrderPropertyId = new Map<string, string | null>();
  for (const row of invoiceWorkOrders ?? []) {
    const rowData = (row.row_data ?? {}) as DemoManagerWorkOrderRow;
    workOrderPropertyId.set(String(row.id), rowData.assignedPropertyId || rowData.propertyId || null);
  }
  let queued = 0;
  for (const invoice of invoices) {
    const managerUserId = String(invoice.manager_user_id);
    const propertyId = workOrderPropertyId.get(String(invoice.work_order_id ?? "")) ?? null;
    // A house with its own reminder rules gets them; an invoice with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    if (!settings.rules.invoice_approval.enabled) continue;
    const anchorIso = isoOrNull(invoice.submitted_at);
    if (!anchorIso || !withinAge(anchorIso, now)) continue;
    const recipients = await managerSideRecipients(db, managerUserId, "invoice_approval", settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    const amount = `$${(Number(invoice.total_cents ?? 0) / 100).toFixed(2)}`;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "invoice_approval",
        subjectId: String(invoice.id),
        anchorIso,
        recipients,
        payload: {
          title: `${vendorName.get(String(invoice.vendor_user_id)) || "A vendor"}’s ${amount} invoice`,
          counterpartyName: vendorName.get(String(invoice.vendor_user_id)) || "A vendor",
          amountLabel: amount,
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/portal/finances`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

type ServiceRequestDbRow = {
  id: string;
  manager_user_id: string;
  resident_email: string | null;
  created_at: string;
  row_data: Record<string, unknown>;
};

async function loadServiceRequests(db: SupabaseClient): Promise<ServiceRequestDbRow[]> {
  const { data, error } = await db
    .from("portal_service_request_records")
    .select("id, manager_user_id, resident_email, created_at, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []).filter(
    (row): row is ServiceRequestDbRow =>
      typeof (row as { manager_user_id?: unknown }).manager_user_id === "string" && Boolean((row as { row_data?: unknown }).row_data),
  );
}

/** `service_request_decision` — an add-on request still pending. */
export async function sweepServiceRequestDecision(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = (await loadServiceRequests(db)).filter((row) => String(row.row_data.status ?? "") === "pending");
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => row.manager_user_id);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const row of rows) {
    const propertyId = typeof row.row_data.propertyId === "string" ? row.row_data.propertyId : null;
    // A house with its own reminder rules gets them; a request with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, propertyId);
    if (!settings.rules.service_request_decision.enabled) continue;
    const anchorIso = isoOrNull(String(row.row_data.requestedAt ?? "")) ?? isoOrNull(row.created_at);
    if (!anchorIso || !withinAge(anchorIso, now)) continue;
    const recipients = await managerSideRecipients(db, row.manager_user_id, "service_request_decision", settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind: "service_request_decision",
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: {
          title: String(row.row_data.offerName ?? "Add-on service"),
          counterpartyName: String(row.row_data.residentName ?? row.resident_email ?? "A resident"),
          amountLabel: String(row.row_data.price ?? ""),
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/portal/services/requests`,
          notificationCategory: "maintenance",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** `service_request_unpaid` — approved, but the resident has not paid to activate it. */
export async function sweepServiceRequestUnpaid(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const rows = (await loadServiceRequests(db)).filter(
    (row) =>
      String(row.row_data.status ?? "") === "approved" &&
      row.row_data.servicePaid !== true &&
      typeof row.row_data.serviceChargeId === "string" &&
      (row.resident_email ?? "").includes("@"),
  );
  if (rows.length === 0) return 0;
  const cache = createSettingsScopeCache();
  let queued = 0;
  for (const row of rows) {
    const propertyId = typeof row.row_data.propertyId === "string" ? row.row_data.propertyId : null;
    // A house with its own reminder rules gets them; a request with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, propertyId);
    if (!settings.rules.service_request_unpaid.enabled) continue;
    const anchorIso = isoOrNull(String(row.row_data.approvedAt ?? ""));
    if (!anchorIso || !withinAge(anchorIso, now)) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind: "service_request_unpaid",
        subjectId: row.id,
        anchorIso,
        recipients: [{ email: String(row.resident_email).trim().toLowerCase(), role: "counterparty", name: String(row.row_data.residentName ?? "") || null }],
        payload: {
          title: String(row.row_data.offerName ?? "Add-on service"),
          amountLabel: String(row.row_data.price ?? ""),
          whenLabel: whenLabel(anchorIso),
          url: `${origin()}/resident/payments`,
          notificationCategory: "payments",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/**
 * `vendor_document_expiry` — a certificate of insurance, license or bond on
 * file that is about to lapse. Anchored on the document's `expiresAt`, which
 * the vendor sets when uploading; documents with no expiry never remind.
 */
export async function sweepVendorDocumentExpiry(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .not("manager_user_id", "is", null)
    .limit(MAX_ROWS);
  if (error) throw error;
  type VendorRow = { id: string; manager_user_id: string; vendor_user_id: string | null; row_data: Record<string, unknown> };
  const rows = (data ?? []) as VendorRow[];
  const candidates = rows.flatMap((row) => {
    const documents = Array.isArray(row.row_data.documents) ? (row.row_data.documents as VendorDocumentRecord[]) : [];
    return documents
      .filter((document) => typeof document.expiresAt === "string" && isoOrNull(document.expiresAt))
      .map((document) => ({ row, document }));
  });
  if (candidates.length === 0) return 0;
  const managerIds = candidates.map(({ row }) => row.manager_user_id);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const { row, document } of candidates) {
    // Vendor records carry no property, so this always resolves through
    // workspace then account (phase C's fallback pin — no behaviour change).
    const settings = await resolveReminderSettingsForRow(db, cache, row.manager_user_id, null);
    if (!settings.rules.vendor_document_expiry.enabled) continue;
    const anchorIso = isoOrNull(document.expiresAt)!;
    if (Date.parse(anchorIso) <= now.getTime()) continue;
    const vendorEmail = String(row.row_data.email ?? "").trim().toLowerCase();
    const vendorName = String(row.row_data.name ?? "").trim() || null;
    const recipients: ReminderRecipient[] = [
      ...(vendorEmail.includes("@") ? [{ email: vendorEmail, role: "vendor" as const, name: vendorName, userId: row.vendor_user_id }] : []),
      ...(await managerSideRecipients(db, row.manager_user_id, "vendor_document_expiry", settings, managerRecipients, null)),
    ];
    if (recipients.length === 0) continue;
    const label = VENDOR_DOCUMENT_LABELS[document.kind] ?? "Document";
    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind: "vendor_document_expiry",
        subjectId: `${row.id}:${document.kind}:${anchorIso.slice(0, 10)}`,
        anchorIso,
        recipients,
        payload: {
          title: label,
          counterpartyName: vendorName ?? "The vendor",
          whenLabel: new Date(anchorIso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }),
          url: `${origin()}/vendor/documents/mine`,
          notificationCategory: "account",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
