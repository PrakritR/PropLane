import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { rosterPhoneIdentifiesVendor, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  classifyInboundText,
  guessTradeFromInboundText,
  parseNameFromInboundText,
  type InboundTextClassification,
} from "@/lib/sms/inbound-text-classification";

/**
 * A text from a number the work number's owner has no resident account, vendor
 * session or manager role for (C2-DT4 / C2-DT5). The webhook has already
 * established WHO owns the line; this module decides what the sender is and
 * records it, once:
 *
 *   * a number already on the owner's vendor list lands on that vendor;
 *   * an unknown number whose text sounds like a trade becomes a vendor;
 *   * any other unknown number becomes ONE Potential resident, deduped by phone;
 *   * STOP / START / HELP keywords create nothing;
 *   * a number that already has a resident application row creates nothing.
 *
 * Every write is keyed on the owner (`managerUserId`, from the claimed receipt
 * and never from the text) and a deterministic id derived from owner + phone, so
 * a webhook retry, a recovery sweep or a second text from the same number
 * upserts the same row instead of adding another.
 *
 * Lookups read only the owner's own rows; nothing here can see another
 * manager's vendors or applications.
 */

type Db = SupabaseClient;

export type InboundTextRouting =
  | { kind: "invalid" }
  | { kind: "stop" }
  /** Already a resident / potential resident with this phone; nothing created. */
  | { kind: "known-resident"; applicationId: string }
  | { kind: "vendor"; vendorId: string | null; vendorUserId: string | null; name: string; created: boolean }
  | { kind: "potential"; applicationId: string; name: string; created: boolean };

/** Plain-JSON phones an application-shaped row can carry (none are sealed fields). */
function phonesOnRow(rowData: unknown): string[] {
  const data = (rowData ?? {}) as {
    phone?: unknown;
    application?: { phone?: unknown };
    manualResidentDetails?: { phone?: unknown };
  };
  return [data.phone, data.application?.phone, data.manualResidentDetails?.phone]
    .map((value) => (typeof value === "string" ? normalizeE164(value) : null))
    .filter((value): value is string => Boolean(value));
}

/** STOP / START / HELP are control keywords: they create or route nothing here. */
const STOP_ONLY_RE = /^\s*(stop|stopall|unsubscribe|end|quit|start|unstop|yes|help)\s*[.!]?\s*$/i;

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").toUpperCase();
}

/** `PROPLANE-<12>`: the id shape every application keeps (normalizeApplicationAxisId passes it through). */
export function smsLeadApplicationId(managerUserId: string, phoneE164: string): string {
  return `PROPLANE-${shortHash("sms-lead", managerUserId, phoneE164).slice(0, 12)}`;
}

export function smsLeadVendorId(managerUserId: string, phoneE164: string): string {
  return `vendor-sms-${shortHash("sms-vendor", managerUserId, phoneE164).slice(0, 16).toLowerCase()}`;
}

/** The placeholder family every phone-only resident already uses (`isPlaceholderResidentEmail`). */
function placeholderLeadEmail(applicationId: string): string {
  return `sms.${applicationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}@import.proplane.local`;
}

/**
 * The one account that VERIFIED this number (`profiles.phone_verified_at`), or
 * null when nobody did or more than one account did - an ambiguous number
 * identifies nobody. A self-typed phone is never evidence.
 */
async function soleVerifiedPhoneOwner(db: Db, phoneE164: string): Promise<string | null> {
  const { data, error } = await db
    .from("profiles")
    .select("id,phone,phone_verified_at")
    .in("phone", profilePhoneVariants(phoneE164))
    .not("phone_verified_at", "is", null)
    .limit(5);
  if (error) throw new Error(`Vendor lookup unavailable: ${error.message}`);
  const owners = [
    ...new Set(
      ((data ?? []) as { id: string; phone: unknown }[])
        .filter((row) => normalizeE164(row.phone) === phoneE164)
        .map((row) => String(row.id)),
    ),
  ];
  return owners.length === 1 ? owners[0]! : null;
}

async function findVendorByPhone(
  db: Db,
  managerUserId: string,
  phoneE164: string,
): Promise<{ id: string; row: ManagerVendorRow; vendorUserId: string | null } | null> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id,row_data,vendor_user_id")
    .eq("manager_user_id", managerUserId)
    // Deterministic: two rows carrying the same number must always answer with
    // the same vendor, never with whatever the planner happened to return first.
    .order("id", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`Vendor lookup unavailable: ${error.message}`);
  const records = (data ?? []) as { id: string; row_data: unknown; vendor_user_id?: string | null }[];
  const live = (record: { row_data: unknown }) => {
    const row = record.row_data as ManagerVendorRow | null;
    return row && row.active !== false ? row : null;
  };
  for (const record of records) {
    const row = live(record);
    // A phone the manager only TYPED into a service link is not identity: a
    // forwarded link puts the real recipient's number on a stranger's row, and
    // matching on it would file the recipient's texts under that account.
    if (row && !rosterPhoneIdentifiesVendor(row)) continue;
    if (row && normalizeE164(row.phone) === phoneE164) {
      return { id: record.id, row, vendorUserId: record.vendor_user_id ?? row.vendorUserId ?? null };
    }
  }
  // A linked vendor account that VERIFIED this number is the vendor too, even
  // when the roster row carries a different phone.
  const owner = await soleVerifiedPhoneOwner(db, phoneE164);
  if (owner) {
    for (const record of records) {
      const row = live(record);
      if (row && (record.vendor_user_id ?? row.vendorUserId) === owner) {
        return { id: record.id, row, vendorUserId: owner };
      }
    }
  }
  return null;
}

/** How far back a manager's own text makes an unknown number "their" vendor. */
export const MANAGER_TEXTED_VENDOR_WINDOW_DAYS = 90;
/** How long a manager's conversation with a vendor outranks the job assistant. */
export const MANAGER_CONVERSATION_WINS_DAYS = 7;

const ACCEPTED_OUTBOUND_STATUSES = ["queued", "claimed", "deferred", "submitting", "submitted", "sent", "delivered", "unknown"];

/**
 * Did THIS workspace owner text this number recently, as a person (the manual
 * send's `manager:` dedupe key - the job assistant's own texts never count)?
 * `vendorOnly` narrows it to texts that went to a vendor thread.
 */
export async function managerTextedPhoneWithin(
  db: Db,
  input: { managerUserId: string; phoneE164: string; days: number; vendorOnly?: boolean; now?: Date },
): Promise<{ texted: boolean; recipientUserId: string | null }> {
  const since = new Date((input.now ?? new Date()).getTime() - input.days * 86_400_000).toISOString();
  let query = db
    .from("sms_outbox")
    .select("recipient_user_id,counterparty_role,created_at")
    .eq("manager_user_id", input.managerUserId)
    .eq("recipient_phone", input.phoneE164)
    .like("dedupe_key", "manager:%")
    .in("status", ACCEPTED_OUTBOUND_STATUSES)
    .gte("created_at", since);
  if (input.vendorOnly) query = query.eq("counterparty_role", "vendor");
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`Outbound lookup unavailable: ${error.message}`);
  const row = ((data ?? []) as { recipient_user_id?: string | null }[])[0];
  return { texted: Boolean(row), recipientUserId: row?.recipient_user_id ?? null };
}

async function findResidentApplicationByPhone(
  db: Db,
  managerUserId: string,
  phoneE164: string,
  ownId: string,
): Promise<string | null> {
  const own = await db
    .from("manager_application_records")
    .select("id")
    .eq("id", ownId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (own.error) throw new Error(`Application lookup unavailable: ${own.error.message}`);
  if (own.data) return ownId;

  const { data, error } = await db
    .from("manager_application_records")
    .select("id,row_data")
    .eq("manager_user_id", managerUserId)
    .limit(2000);
  if (error) throw new Error(`Application lookup unavailable: ${error.message}`);
  for (const record of (data ?? []) as { id: string; row_data: unknown }[]) {
    if (phonesOnRow(record.row_data).includes(phoneE164)) return record.id;
  }
  return null;
}

function leadName(body: string, phoneE164: string): string {
  return parseNameFromInboundText(body) || formatSmsPhoneLabel(phoneE164) || phoneE164;
}

/**
 * Decide what an unrecognized texter is and record it. Throws on a read or
 * write failure so the caller can leave the receipt retryable; a retry reaches
 * the same deterministic ids.
 */
export async function routeUnrecognizedInboundText(
  db: Db,
  input: {
    /** The workspace owner the claimed receipt belongs to. */
    managerUserId: string;
    /** The workspace whose work number was texted, when the line is placed. */
    workspaceId?: string | null;
    fromPhone: string;
    body: string;
  },
): Promise<InboundTextRouting> {
  const managerUserId = input.managerUserId.trim();
  const phone = normalizeE164(input.fromPhone);
  if (!managerUserId || !phone) return { kind: "invalid" };

  const leadId = smsLeadApplicationId(managerUserId, phone);
  const [vendor, application] = await Promise.all([
    findVendorByPhone(db, managerUserId, phone),
    findResidentApplicationByPhone(db, managerUserId, phone, leadId),
  ]);

  // A number the manager texted as a vendor in the last 90 days answers in
  // THAT thread, whatever it says: it is never a Potential resident or a new vendor.
  const texted = vendor || application
    ? null
    : await managerTextedPhoneWithin(db, {
        managerUserId,
        phoneE164: phone,
        days: MANAGER_TEXTED_VENDOR_WINDOW_DAYS,
        vendorOnly: true,
      });
  if (texted?.texted && !STOP_ONLY_RE.test(input.body || "")) {
    return {
      kind: "vendor",
      vendorId: null,
      vendorUserId: texted.recipientUserId,
      name: formatSmsPhoneLabel(phone) ?? phone,
      created: false,
    };
  }

  const classification: InboundTextClassification = classifyInboundText({
    direction: "in",
    body: input.body,
    knownVendor: Boolean(vendor),
    vendorLabel: vendor?.row.name,
    // A phone that already has an application row (a Potential resident from an
    // earlier text, or a resident added by hand) is known: the text joins the
    // existing thread and nothing new is created.
    knownResident: Boolean(application),
  });

  switch (classification.kind) {
    case "stop":
      return { kind: "stop" };
    case "vendor-known":
      return {
        kind: "vendor",
        vendorId: vendor!.id,
        vendorUserId: vendor!.vendorUserId,
        name: vendor!.row.name,
        created: false,
      };
    case "known":
      return { kind: "known-resident", applicationId: application! };
    case "vendor-new":
      return createVendor(db, { managerUserId, phone, body: input.body });
    case "potential-new":
      return createPotentialResident(db, {
        managerUserId,
        workspaceId: input.workspaceId ?? null,
        phone,
        body: input.body,
      });
    default:
      return { kind: "invalid" };
  }
}

async function createVendor(
  db: Db,
  input: { managerUserId: string; phone: string; body: string; name?: string; trade?: string },
): Promise<InboundTextRouting> {
  const id = smsLeadVendorId(input.managerUserId, input.phone);
  const trade = input.trade?.trim() || guessTradeFromInboundText(input.body);
  const name =
    input.name?.trim() || parseNameFromInboundText(input.body) || `${trade} · ${formatSmsPhoneLabel(input.phone) ?? input.phone}`;
  const now = new Date().toISOString();
  const row: ManagerVendorRow = {
    id,
    managerUserId: input.managerUserId,
    name,
    trade,
    trades: [trade],
    phone: input.phone,
    email: "",
    notes: "",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  // ignoreDuplicates: a second text racing the first keeps the first row.
  const { error } = await db
    .from("manager_vendor_records")
    .upsert(
      { id, manager_user_id: input.managerUserId, vendor_user_id: null, row_data: row, updated_at: now },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Could not add the vendor: ${error.message}`);
  return { kind: "vendor", vendorId: id, vendorUserId: null, name, created: true };
}

async function createPotentialResident(
  db: Db,
  input: { managerUserId: string; workspaceId: string | null; phone: string; body: string },
): Promise<InboundTextRouting> {
  const id = smsLeadApplicationId(input.managerUserId, input.phone);
  const name = leadName(input.body, input.phone);
  const now = new Date().toISOString();
  const row = {
    id,
    name,
    property: "",
    // Shown as "Incomplete" under Residents > Potential: somebody who texted, not yet an applicant.
    stage: "In progress",
    bucket: "pending" as const,
    email: placeholderLeadEmail(id),
    phone: input.phone,
    detail: "Texted the work number",
    managerUserId: input.managerUserId,
    // Plumbing row like a booking residency: never counted as a submitted
    // application, never reminded (`isBookingResidencyRow`).
    smsLead: true,
    ...(input.workspaceId ? { smsLeadWorkspaceId: input.workspaceId } : {}),
  };
  // ignoreDuplicates: the second text from this number (or a retry) keeps the first row and its edits.
  const { error } = await db.from("manager_application_records").upsert(
    {
      id,
      manager_user_id: input.managerUserId,
      resident_email: row.email,
      row_data: sealApplicantRow(row, id, input.managerUserId),
      updated_at: now,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Could not add the Potential resident: ${error.message}`);
  return { kind: "potential", applicationId: id, name, created: true };
}

export type OutboundVendorResult = { vendorId: string; name: string; created: boolean };

/**
 * Has this account PROVED it holds `phone`? `profiles.phone_verified_at` with
 * the same number is the one verification PropLane performs; a self-typed
 * `vendor_business_profiles.work_phone` is not evidence of anything.
 * Fails closed: an unreadable profile is not verified.
 */
async function accountVerifiedPhone(db: Db, userId: string, phone: string): Promise<boolean> {
  const id = userId.trim();
  if (!id || !phone) return false;
  const { data, error } = await db
    .from("profiles")
    .select("phone, phone_verified_at")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return false;
  const row = data as { phone?: string | null; phone_verified_at?: string | null };
  if (!row.phone_verified_at) return false;
  return normalizeE164(row.phone ?? "") === phone;
}

/**
 * After a manager texts a number from PropLane: make sure a vendor ends up on
 * their list when the number IS a vendor (C2-DT5). The manager ticking "This is
 * a vendor" is the signal for a stranger; a number a PropLane vendor account has
 * VERIFIED is added without the tick, linked to that account. An account that
 * merely lists the number is not linked - the text goes out and the roster is
 * left alone. A number already on the list changes nothing. Returns null when the
 * number is not a vendor, so an ordinary text creates nothing.
 */
export async function ensureVendorForOutboundText(
  db: Db,
  input: { managerUserId: string; toPhone: string; body: string; markedVendor: boolean; name?: string; trade?: string },
): Promise<OutboundVendorResult | null> {
  const managerUserId = input.managerUserId.trim();
  const phone = normalizeE164(input.toPhone);
  if (!managerUserId || !phone) return null;

  const existing = await findVendorByPhone(db, managerUserId, phone);
  if (existing) return { vendorId: existing.id, name: existing.row.name, created: false };

  // A PropLane vendor account that lists this number (never matched on a name).
  const national = phone.replace(/^\+1/, "");
  const variants = [
    ...new Set(
      [
        phone,
        national,
        formatSmsPhoneLabel(phone) ?? "",
        `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
        `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`,
      ].filter((value) => value && value.replace(/\D/g, "").length >= 10),
    ),
  ];
  const { data: profiles, error: profileError } = await db
    .from("vendor_business_profiles")
    .select("user_id,business_name,work_email,work_phone,trades")
    .in("work_phone", variants)
    .limit(5);
  if (profileError) throw new Error(`Vendor lookup unavailable: ${profileError.message}`);
  const account = ((profiles ?? []) as {
    user_id: string;
    business_name: string | null;
    work_email: string | null;
    work_phone: string | null;
    trades: unknown;
  }[]).find((row) => normalizeE164(row.work_phone) === phone);

  // `work_phone` is free text the vendor types about themselves, so a match is a
  // CLAIM on the number, not proof of it. Linking on the claim alone let any
  // account that typed a real contractor's number be pulled onto the manager's
  // roster - reachable by roster messaging, offers and task assignments - the
  // moment the manager texted that contractor. Only an account that VERIFIED
  // this number is linked; everyone else gets the ordinary unlinked path below.
  if (account && (await accountVerifiedPhone(db, account.user_id, phone))) {
    const { data: linked, error: linkedError } = await db
      .from("manager_vendor_records")
      .select("id,row_data")
      .eq("manager_user_id", managerUserId)
      .eq("vendor_user_id", account.user_id)
      .maybeSingle();
    if (linkedError) throw new Error(`Vendor lookup unavailable: ${linkedError.message}`);
    if (linked) {
      return { vendorId: String(linked.id), name: (linked.row_data as ManagerVendorRow | null)?.name ?? "Vendor", created: false };
    }
    const trades = Array.isArray(account.trades) ? (account.trades as string[]) : [];
    const id = smsLeadVendorId(managerUserId, phone);
    const now = new Date().toISOString();
    const row: ManagerVendorRow = {
      id,
      managerUserId,
      name: account.business_name?.trim() || "PropLane vendor",
      trade: trades[0] ?? "",
      trades: trades.length ? trades : undefined,
      phone: account.work_phone?.trim() || phone,
      email: account.work_email?.trim() || "",
      notes: "",
      active: true,
      vendorUserId: account.user_id,
      catalogId: `self-serve-${account.user_id}`,
      createdAt: now,
      updatedAt: now,
    };
    const { error } = await db.from("manager_vendor_records").upsert(
      { id, manager_user_id: managerUserId, vendor_user_id: account.user_id, row_data: row, updated_at: now },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Could not add the vendor: ${error.message}`);
    return { vendorId: id, name: row.name, created: true };
  }

  if (!input.markedVendor) return null;
  const created = await createVendor(db, { managerUserId, phone, body: input.body, name: input.name, trade: input.trade });
  return created.kind === "vendor" && created.vendorId ? { vendorId: created.vendorId, name: created.name, created: created.created } : null;
}
