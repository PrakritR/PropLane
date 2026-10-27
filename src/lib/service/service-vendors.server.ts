import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveServiceOwner } from "@/lib/service/service-owner.server";
import {
  SERVICE_VENDOR_CONSENT_BASIS,
  SERVICE_VENDOR_ID_PREFIX,
  cleanServiceVendorInput,
  composeServiceVendorIntro,
  serviceVendorTradeLabels,
  type ServiceVendorInput,
  type ServiceVendorView,
} from "@/lib/service/service-vendors";
import { readVendorTextConsent } from "@/lib/sms/vendor-conversation-consent.server";
import { writeAuditLog } from "@/lib/tools/audit";
import { vendorDispatchRoles } from "@/lib/vendor-dispatch/vendor-roles";

/**
 * The PropLane Service vendor roster (admin Service > Vendors). One list for the whole service: a roster vendor is a
 * `manager_vendor_records` row OWNED BY THE SERVICE OWNER with `row_data.serviceRoster = true` (see `service-vendors.ts`).
 *
 * Every verb re-derives the service owner from `platform_service_settings` and only ever touches rows that owner owns
 * AND that carry the roster flag, so a body id is a name, never a grant. Callers (the admin routes) have already run
 * `requireAdminRoute()`.
 *
 * Consent: an admin adding a person they already know is the "prior relationship" basis the roster text rail documents
 * (`VENDOR_TEXT_ATTESTATION_SOURCE`, recorded with the first text and who attested). A number that has texted STOP is
 * never texted, whatever an admin types: `readVendorTextConsent` reads STOP first and it is final.
 */

type RosterRow = ManagerVendorRow & {
  serviceRoster?: boolean;
  rosterAddedBy?: string;
  rosterAddedAt?: string;
  rosterRemovedAt?: string;
  consentBasis?: string;
  introSentAt?: string;
};

type RosterRecord = { id: string; manager_user_id: string; vendor_user_id: string | null; row_data: RosterRow | null };

export type ServiceVendorFailure = { ok: false; status: number; error: string };
export type ServiceVendorOk<T extends object = object> = { ok: true } & T;

const NO_OWNER: ServiceVendorFailure = { ok: false, status: 409, error: "The service owner is not set up." };

function fail(status: number, error: string): ServiceVendorFailure {
  return { ok: false, status, error };
}

async function ownerOf(db: SupabaseClient): Promise<string | null> {
  const owner = await resolveServiceOwner(db);
  return owner.ok ? owner.ownerUserId : null;
}

async function loadRosterRecords(db: SupabaseClient, ownerUserId: string): Promise<RosterRecord[] | null> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("manager_user_id", ownerUserId);
  if (error) return null;
  return ((data ?? []) as RosterRecord[]).filter((record) => record.row_data?.serviceRoster === true);
}

async function loadRosterRecord(db: SupabaseClient, ownerUserId: string, id: string): Promise<RosterRecord | null> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", id)
    .eq("manager_user_id", ownerUserId)
    .maybeSingle();
  if (error || !data) return null;
  const record = data as RosterRecord;
  return record.row_data?.serviceRoster === true ? record : null;
}

/** The PropLane vendor account that owns this phone (verified, exactly one), so the roster entry links to it. */
async function vendorAccountForPhone(db: SupabaseClient, phone: string): Promise<string | null> {
  try {
    const profile = await findVerifiedProfileByPhone(db, phone);
    if (!profile) return null;
    const { data } = await db.from("vendor_business_profiles").select("user_id").eq("user_id", profile.id).maybeSingle();
    return data ? profile.id : null;
  } catch {
    return null;
  }
}

async function viewOf(db: SupabaseClient, ownerUserId: string, record: RosterRecord): Promise<ServiceVendorView> {
  const row = record.row_data!;
  const phone = normalizeE164(String(row.phone ?? "")) ?? String(row.phone ?? "");
  const vendorUserId = record.vendor_user_id ?? row.vendorUserId ?? null;
  let optedOut = false;
  try {
    const consent = await readVendorTextConsent(db, { managerUserId: ownerUserId, vendorUserId, phone });
    optedOut = consent.ok && (consent.state === "opted_out" || consent.state === "revoked");
  } catch {
    optedOut = false;
  }
  return {
    id: record.id,
    name: String(row.name ?? ""),
    phone,
    trades: vendorDispatchRoles(row),
    area: String(row.serviceArea ?? ""),
    paused: row.dispatchAvailable === false,
    optedOut,
    introSentAt: row.introSentAt ?? null,
    hasAccount: Boolean(vendorUserId),
  };
}

export async function listServiceVendors(db: SupabaseClient): Promise<ServiceVendorOk<{ configured: boolean; vendors: ServiceVendorView[] }> | ServiceVendorFailure> {
  const ownerUserId = await ownerOf(db);
  if (!ownerUserId) return { ok: true, configured: false, vendors: [] };
  const records = await loadRosterRecords(db, ownerUserId);
  if (!records) return fail(503, "Could not load the vendors. Please retry.");
  const live = records.filter((record) => record.row_data?.active !== false && !record.row_data?.rosterRemovedAt);
  const vendors = await Promise.all(live.map((record) => viewOf(db, ownerUserId, record)));
  vendors.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, configured: true, vendors };
}

function rowFor(input: ServiceVendorInput, base: Partial<RosterRow>, ownerUserId: string, id: string, vendorUserId: string | null): RosterRow {
  const labels = serviceVendorTradeLabels(input.trades);
  return {
    notes: "",
    email: "",
    ...base,
    id,
    managerUserId: ownerUserId,
    name: input.name,
    trade: labels[0] ?? "",
    trades: labels,
    phone: input.phone,
    active: true,
    dispatchTrades: input.trades,
    serviceArea: input.area || undefined,
    dispatchAvailable: base.dispatchAvailable === false ? false : true,
    vendorUserId: vendorUserId ?? undefined,
    serviceRoster: true,
    rosterRemovedAt: undefined,
    consentBasis: SERVICE_VENDOR_CONSENT_BASIS,
  } as RosterRow;
}

async function adminFirstName(db: SupabaseClient, adminUserId: string): Promise<string> {
  try {
    const { data } = await db.from("profiles").select("full_name").eq("id", adminUserId).maybeSingle();
    return String((data as { full_name?: unknown } | null)?.full_name ?? "").trim().split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * The ONE intro text. Sent at most once per roster entry (`introSentAt`), never to a STOPped number, from the
 * PropLane line (the service owner's number, or the shared line while it is live). Returns whether it left.
 */
export async function sendServiceVendorIntro(
  db: SupabaseClient,
  input: { ownerUserId: string; recordId: string; adminUserId: string },
): Promise<"sent" | "already_sent" | "opted_out" | "failed"> {
  const record = await loadRosterRecord(db, input.ownerUserId, input.recordId);
  const row = record?.row_data;
  if (!record || !row || row.active === false) return "failed";
  if (row.introSentAt) return "already_sent";
  const phone = normalizeE164(String(row.phone ?? ""));
  if (!phone) return "failed";
  const vendorUserId = record.vendor_user_id ?? row.vendorUserId ?? null;
  const consent = await readVendorTextConsent(db, { managerUserId: input.ownerUserId, vendorUserId, phone }).catch(() => null);
  if (!consent?.ok) return "failed";
  if (consent.state === "opted_out" || consent.state === "revoked") return "opted_out";

  const workspaceId = await userDefaultWorkspaceId(db, input.ownerUserId);
  const result = await sendManagerConversationSms(db, {
    actorUserId: input.ownerUserId,
    author: "assistant",
    // One intro per roster entry, however many times this is retried.
    idempotencyKey: `svc-vendor-intro-${record.id}-${phone.slice(-10)}-${(row.rosterAddedAt ?? "").replace(/[^0-9]/g, "")}`.padEnd(16, "0"),
    toPhone: phone,
    text: composeServiceVendorIntro({ adminFirstName: await adminFirstName(db, input.adminUserId) }),
    vendorRecordId: record.id,
    // The admin who added this person has the prior relationship; the first text carries the sender line and STOP.
    attestVendorRelationship: true,
    workspace: { id: workspaceId || null },
  }).catch(() => null);
  if (!result || result.status >= 300 || result.body.error) {
    return String(result?.body?.error ?? "").includes("opted out") ? "opted_out" : "failed";
  }
  const nowIso = new Date().toISOString();
  await db
    .from("manager_vendor_records")
    .update({ row_data: { ...row, introSentAt: nowIso }, updated_at: nowIso })
    .eq("id", record.id)
    .eq("manager_user_id", input.ownerUserId);
  return "sent";
}

async function audit(db: SupabaseClient, adminUserId: string, action: string, summary: Record<string, unknown>): Promise<boolean> {
  const out = await writeAuditLog(
    { db, landlordId: adminUserId, userId: adminUserId },
    { action, toolName: action, inputSummary: summary, resultSummary: { applied: true }, dedupeKey: `${action}:${adminUserId}:${Date.now()}:${randomUUID().slice(0, 8)}` },
  );
  return out.recorded;
}

export type AddServiceVendorResult = ServiceVendorOk<{ vendor: ServiceVendorView; intro: "sent" | "already_sent" | "opted_out" | "failed" }> | ServiceVendorFailure;

export async function addServiceVendor(db: SupabaseClient, adminUserId: string, raw: Record<string, unknown>): Promise<AddServiceVendorResult> {
  const parsed = cleanServiceVendorInput(raw);
  if (!parsed.ok) return fail(400, parsed.error);
  const input = parsed.value;
  const ownerUserId = await ownerOf(db);
  if (!ownerUserId) return NO_OWNER;

  // One entry per phone. The service owner's own vendor list is searched too, so a vendor already there is promoted
  // to the roster rather than duplicated.
  const { data: owned, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("manager_user_id", ownerUserId);
  if (error) return fail(503, "Could not save the vendor. Please retry.");
  const existing = ((owned ?? []) as RosterRecord[]).find((record) => normalizeE164(String(record.row_data?.phone ?? "")) === input.phone);
  if (existing?.row_data?.serviceRoster === true && existing.row_data.active !== false && !existing.row_data.rosterRemovedAt) {
    return fail(409, "That number is already on the list.");
  }

  const linked = existing?.vendor_user_id ?? (await vendorAccountForPhone(db, input.phone));
  const id = existing?.id ?? `${SERVICE_VENDOR_ID_PREFIX}${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const wasRemoved = Boolean(existing?.row_data?.serviceRoster === true);
  const base: Partial<RosterRow> = existing?.row_data ? { ...existing.row_data } : {};
  const row = rowFor(input, base, ownerUserId, id, linked);
  row.rosterAddedBy = adminUserId;
  row.rosterAddedAt = nowIso;
  // A removed entry coming back gets a fresh intro; a promoted vendor of the owner's own was never introduced.
  row.introSentAt = undefined;
  row.updatedAt = nowIso;

  if (!(await audit(db, adminUserId, "admin_service_vendor_add", { vendorId: id, trades: input.trades, linked: Boolean(linked), reactivated: wasRemoved }))) {
    return fail(503, "Could not record the change. Nothing was changed.");
  }
  const record = { id, manager_user_id: ownerUserId, vendor_user_id: linked, row_data: row, updated_at: nowIso };
  const written = existing
    ? await db.from("manager_vendor_records").update(record).eq("id", id).eq("manager_user_id", ownerUserId)
    : await db.from("manager_vendor_records").insert(record);
  if (written.error) return fail(503, "Could not save the vendor. Please retry.");

  const intro = await sendServiceVendorIntro(db, { ownerUserId, recordId: id, adminUserId });
  const saved = await loadRosterRecord(db, ownerUserId, id);
  return { ok: true, vendor: await viewOf(db, ownerUserId, saved ?? ({ ...record } as RosterRecord)), intro };
}

export type UpdateServiceVendorInput = Record<string, unknown> & { paused?: unknown };

export async function updateServiceVendor(db: SupabaseClient, adminUserId: string, id: string, raw: UpdateServiceVendorInput): Promise<ServiceVendorOk<{ vendor: ServiceVendorView; intro?: "sent" | "already_sent" | "opted_out" | "failed" }> | ServiceVendorFailure> {
  const ownerUserId = await ownerOf(db);
  if (!ownerUserId) return NO_OWNER;
  const record = await loadRosterRecord(db, ownerUserId, id.trim());
  if (!record?.row_data || record.row_data.rosterRemovedAt) return fail(404, "Vendor not found.");
  const current = record.row_data;
  const nowIso = new Date().toISOString();

  // Pause / resume only.
  if (typeof raw.paused === "boolean" && raw.name === undefined) {
    if (!(await audit(db, adminUserId, "admin_service_vendor_pause", { vendorId: id, paused: raw.paused }))) return fail(503, "Could not record the change. Nothing was changed.");
    const row = { ...current, dispatchAvailable: !raw.paused, updatedAt: nowIso };
    const written = await db.from("manager_vendor_records").update({ row_data: row, updated_at: nowIso }).eq("id", record.id).eq("manager_user_id", ownerUserId);
    if (written.error) return fail(503, "Could not save the vendor. Please retry.");
    return { ok: true, vendor: await viewOf(db, ownerUserId, { ...record, row_data: row }) };
  }

  const parsed = cleanServiceVendorInput({
    name: raw.name ?? current.name,
    phone: raw.phone ?? current.phone,
    trades: raw.trades ?? vendorDispatchRoles(current),
    area: raw.area ?? current.serviceArea ?? "",
  });
  if (!parsed.ok) return fail(400, parsed.error);
  const input = parsed.value;
  const phoneChanged = normalizeE164(String(current.phone ?? "")) !== input.phone;
  if (phoneChanged) {
    const others = await loadRosterRecords(db, ownerUserId);
    if (!others) return fail(503, "Could not save the vendor. Please retry.");
    if (others.some((other) => other.id !== record.id && !other.row_data?.rosterRemovedAt && other.row_data?.active !== false && normalizeE164(String(other.row_data?.phone ?? "")) === input.phone)) {
      return fail(409, "That number is already on the list.");
    }
  }
  const linked = phoneChanged ? await vendorAccountForPhone(db, input.phone) : record.vendor_user_id;
  const row = rowFor(input, { ...current, dispatchAvailable: typeof raw.paused === "boolean" ? !raw.paused : current.dispatchAvailable }, ownerUserId, record.id, linked);
  row.updatedAt = nowIso;
  // A new number is a new person to introduce.
  if (phoneChanged) row.introSentAt = undefined;

  if (!(await audit(db, adminUserId, "admin_service_vendor_edit", { vendorId: id, phoneChanged, trades: input.trades }))) return fail(503, "Could not record the change. Nothing was changed.");
  const written = await db.from("manager_vendor_records").update({ vendor_user_id: linked, row_data: row, updated_at: nowIso }).eq("id", record.id).eq("manager_user_id", ownerUserId);
  if (written.error) return fail(503, "Could not save the vendor. Please retry.");
  const intro = phoneChanged ? await sendServiceVendorIntro(db, { ownerUserId, recordId: record.id, adminUserId }) : undefined;
  return { ok: true, vendor: await viewOf(db, ownerUserId, { ...record, vendor_user_id: linked, row_data: row }), ...(intro ? { intro } : {}) };
}

/**
 * Remove from the roster. The record stays (inactive, stamped) so past dispatch history and its consent ledger keep
 * their vendor; dispatch never offers an inactive vendor and the admin list hides it.
 */
export async function removeServiceVendor(db: SupabaseClient, adminUserId: string, id: string): Promise<ServiceVendorOk | ServiceVendorFailure> {
  const ownerUserId = await ownerOf(db);
  if (!ownerUserId) return NO_OWNER;
  const record = await loadRosterRecord(db, ownerUserId, id.trim());
  if (!record?.row_data || record.row_data.rosterRemovedAt) return fail(404, "Vendor not found.");
  if (!(await audit(db, adminUserId, "admin_service_vendor_remove", { vendorId: id }))) return fail(503, "Could not record the change. Nothing was changed.");
  const nowIso = new Date().toISOString();
  const row = { ...record.row_data, active: false, rosterRemovedAt: nowIso, updatedAt: nowIso };
  const written = await db.from("manager_vendor_records").update({ row_data: row, updated_at: nowIso }).eq("id", record.id).eq("manager_user_id", ownerUserId);
  if (written.error) return fail(503, "Could not remove the vendor. Please retry.");
  return { ok: true };
}

/**
 * The dispatch path's roster hook (`on/paycore` added the call site in `fallbackChain`): the reachable PropLane Service roster
 * vendors for a job of `trade` in `workspaceId`; `[]` for any workspace that is not a service workspace. The body lives with
 * the dispatch engine (`vendor-dispatch/service-roster.server.ts`); it is re-exported here, the roster's own module.
 */
export { serviceRosterVendorsForTrade } from "@/lib/vendor-dispatch/service-roster.server";
