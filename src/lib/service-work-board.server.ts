import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { rateLimit } from "@/lib/rate-limit";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import {
  publicBoardServiceProjection,
  publicServiceProjection,
  type PublicBoardServiceView,
  type PublicServiceView,
} from "@/lib/public-service-projection";
import { resolveServiceShareToken } from "@/lib/service-share-links.server";
import { vendorCapabilitiesMatchCategory } from "@/lib/work-order-taxonomy";
import {
  vendorIsOnboardedForBoard,
  vendorMatchesZip,
  resolveWorkOrderPropertyZip,
  workOrderCategoryForMarketplace,
  type DirectoryProfileRow,
} from "@/lib/work-order-marketplace-match.server";
import { offerExpiresAt } from "@/lib/service-automation-settings";
import { resolveServiceAutomationSettingsForRow } from "@/lib/service-automation-settings.server";
import { createSettingsScopeCache } from "@/lib/settings/scope-resolver.server";
import { track } from "@/lib/analytics/posthog";

/**
 * The vendor work board and the texted service link (vendor-work-share-1006).
 *
 * Two doors onto ONE existing flow. Whichever door a vendor comes through, the result is the same
 * thing a manager's own "Send job" makes: a roster row on the manager's workspace and a `sent` row
 * in `work_order_vendor_offers`. From there the existing offer -> estimate / bid -> approve cycle
 * runs untouched (`work-order-bids.server.ts`): only a submitted bid is approvable, one accepted
 * bid per service, the accepted amount immutable, vendors scoped by `vendor_user_id`, and every
 * offer / bid written only by service-role code like this.
 *
 * What this file adds is the two places a service reaches a vendor the manager did not pick from
 * their own roster, so it is strict about three things:
 *  - what such a vendor may read (`publicServiceProjection`, an allowlist - never a service row);
 *  - when the manager learns who they are (contact is held until the first submitted bid);
 *  - how fast one vendor, or one service, can be asked for (rate limit + per-service cap).
 */

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Requests (offers) one published or texted service accepts from strangers. */
export const MAX_BOARD_REQUESTS_PER_SERVICE = 25;
/** Job requests one vendor may make per hour, across all services. */
export const BOARD_REQUESTS_PER_VENDOR_PER_HOUR = 15;

export type BoardOrigin = "service_link" | "work_board";
export type BoardChoice = "estimate" | "bid" | "message";

export type BoardActionFailure = { ok: false; status: number; error: string };

/** A manager's display name for the public view: their profile name, never their email. */
async function managerDisplayName(db: Db, managerUserId: string): Promise<string> {
  const { data } = await db.from("profiles").select("full_name").eq("id", managerUserId).maybeSingle();
  return typeof data?.full_name === "string" ? data.full_name.trim() : "";
}

/** True while a service can still be bid on by someone who is not hired: not assigned, not done, not cancelled. */
export function serviceIsOpenToNewRequests(
  record: { vendor_user_id?: string | null },
  row: DemoManagerWorkOrderRow,
): boolean {
  if (record.vendor_user_id) return false;
  if (row.vendorId || row.vendorAssignedAt || row.selfAssigned || row.assignee) return false;
  if (row.bucket === "completed" || row.bucket === "scheduled" || row.completedAt) return false;
  if (/cancel|declin/i.test(String(row.status ?? ""))) return false;
  return true;
}

/* ------------------------------------------------------------------------------------------ */
/* Publish / Unpublish (manager)                                                              */
/* ------------------------------------------------------------------------------------------ */

export type PublishActor = { userId: string; role: string; admin: boolean };

async function loadOwnedService(db: Db, actor: PublishActor, workOrderId: string) {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false as const, status: 403, error: "Forbidden." };
  }
  const id = workOrderId.trim();
  if (!id) return { ok: false as const, status: 400, error: "Service id required." };
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", id)
    .maybeSingle();
  if (!record || (!actor.admin && record.manager_user_id !== actor.userId)) {
    return { ok: false as const, status: 403, error: "Forbidden." };
  }
  return { ok: true as const, record, row: (record.row_data ?? {}) as DemoManagerWorkOrderRow };
}

function newPublishRef(): string {
  return `pub_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function publishServiceToBoard(
  db: Db,
  actor: PublishActor,
  input: { workOrderId: string; budgetCents?: number | null; sharePhotos?: boolean },
): Promise<{ ok: true; patch: Pick<DemoManagerWorkOrderRow, "published" | "publishedAt" | "publishRef" | "publishBudgetCents" | "publishSharePhotos" | "biddingOpen" | "biddingOpenedAt"> } | BoardActionFailure> {
  const loaded = await loadOwnedService(db, actor, input.workOrderId);
  if (!loaded.ok) return loaded;
  const { record, row } = loaded;
  if (!serviceIsOpenToNewRequests(record, row)) {
    return { ok: false, status: 409, error: "Only an open service can be published." };
  }
  // An approved bid is a hire even when the row has not caught up yet.
  const { data: accepted, error: acceptedError } = await db
    .from("work_order_bids")
    .select("id")
    .eq("work_order_id", String(record.id))
    .eq("status", "accepted")
    .limit(1);
  if (acceptedError) return { ok: false, status: 500, error: acceptedError.message };
  if ((accepted ?? []).length > 0) {
    return { ok: false, status: 409, error: "A bid is already approved on this service." };
  }
  const budget = input.budgetCents;
  const budgetCents =
    typeof budget === "number" && Number.isFinite(budget) && budget > 0 && budget <= 100_000_000 ? Math.round(budget) : null;
  const now = new Date().toISOString();
  const patch = {
    published: true,
    publishedAt: row.publishedAt && row.published ? row.publishedAt : now,
    // The ref is stable across a re-publish of the same service so a vendor's open tab keeps working.
    publishRef: row.publishRef?.trim() || newPublishRef(),
    publishBudgetCents: budgetCents,
    publishSharePhotos: input.sharePhotos === true,
    // Publishing opens bidding: a vendor can only answer while it is open (`resolveVendorWorkOrderAccess`).
    biddingOpen: true,
    biddingOpenedAt: row.biddingOpenedAt ?? now,
  };
  const next = { ...row, ...patch };
  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: stampSmsTestProvenance(next as unknown as Record<string, unknown>), updated_at: now })
    .eq("id", String(record.id));
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, patch };
}

export async function unpublishServiceFromBoard(
  db: Db,
  actor: PublishActor,
  input: { workOrderId: string },
): Promise<{ ok: true } | BoardActionFailure> {
  const loaded = await loadOwnedService(db, actor, input.workOrderId);
  if (!loaded.ok) return loaded;
  const { record, row } = loaded;
  const now = new Date().toISOString();
  // Unpublishing takes it off the board. Vendors who already requested keep their offer and bid:
  // the manager removes a request through Vendors, exactly as for any offered vendor.
  const next = { ...row, published: false };
  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: stampSmsTestProvenance(next as unknown as Record<string, unknown>), updated_at: now })
    .eq("id", String(record.id));
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------ */
/* The vendor side: eligibility, the board, requesting a job                                  */
/* ------------------------------------------------------------------------------------------ */

const PROFILE_COLUMNS =
  "user_id, business_name, work_email, work_phone, trades, service_area_zips, service_radius_miles, license_number, insurance_expires_at, insurance_doc_path, directory_listed, onboarding_completed_at";

type VendorProfile = DirectoryProfileRow & { business_name: string | null; work_email: string | null; work_phone: string | null };

async function loadVendorProfile(db: Db, vendorUserId: string): Promise<VendorProfile | null> {
  const { data } = await db.from("vendor_business_profiles").select(PROFILE_COLUMNS).eq("user_id", vendorUserId).maybeSingle();
  return (data as VendorProfile | null) ?? null;
}

export type BoardEligibility = { ok: true; profile: VendorProfile } | { ok: false; status: number; error: string };

/** Decide #2: any ONBOARDED vendor with a trade and a service area. */
export async function resolveBoardEligibility(db: Db, vendorUserId: string): Promise<BoardEligibility> {
  const profile = await loadVendorProfile(db, vendorUserId);
  if (!profile || !vendorIsOnboardedForBoard(profile)) {
    return { ok: false, status: 403, error: "Finish setting up your business (a trade and a service area) to request jobs." };
  }
  return { ok: true, profile };
}

export type FindWorkFilters = { trade?: string; radiusMi?: number };

/**
 * The board: services a manager published that this vendor's trade and service area cover. Signed
 * in vendors only (the route enforces it); each entry is the public allowlist view plus the opaque
 * ref - never a service row. Services the vendor already holds an offer on live under Open, not
 * here, and a service disappears the moment it is hired, completed, cancelled or unpublished.
 */
export async function listBoardServices(
  db: Db,
  vendorUserId: string,
  filters: FindWorkFilters = {},
): Promise<{ ok: true; services: PublicBoardServiceView[] } | BoardActionFailure> {
  const eligibility = await resolveBoardEligibility(db, vendorUserId);
  if (!eligibility.ok) return { ok: true, services: [] };
  const { profile } = eligibility;

  const { data: records, error } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("row_data->>published", "true")
    .is("vendor_user_id", null)
    .is("test_workspace_id", null)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, status: 500, error: error.message };

  const candidates = (records ?? []).filter((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    return row.published === true && serviceIsOpenToNewRequests(record, row);
  });
  if (candidates.length === 0) return { ok: true, services: [] };

  // Already asked / offered: those are the vendor's Open tab, not new work.
  const { data: directoryRows } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", vendorUserId);
  const directoryIds = (directoryRows ?? []).map((row) => String(row.id));
  const heldIds = new Set<string>();
  const { data: byUser } = await db.from("work_order_vendor_offers").select("work_order_id").eq("vendor_user_id", vendorUserId);
  for (const offer of byUser ?? []) heldIds.add(String(offer.work_order_id));
  if (directoryIds.length > 0) {
    const { data: byDirectory } = await db.from("work_order_vendor_offers").select("work_order_id").in("vendor_directory_id", directoryIds);
    for (const offer of byDirectory ?? []) heldIds.add(String(offer.work_order_id));
  }

  const radius = Math.min(Math.max(1, Math.round(Number(filters.radiusMi) || 0)) || 25, 50);
  const tradeFilter = filters.trade?.trim().toLowerCase() ?? "";
  const trades = Array.isArray(profile.trades) ? profile.trades : [];

  const matched: { record: (typeof candidates)[number]; row: DemoManagerWorkOrderRow }[] = [];
  for (const record of candidates) {
    if (heldIds.has(String(record.id))) continue;
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    const category = workOrderCategoryForMarketplace(row, row.category ?? "Maintenance");
    if (!category || !vendorCapabilitiesMatchCategory(trades, category)) continue;
    if (tradeFilter && category.toLowerCase() !== tradeFilter && !String(row.category ?? "").toLowerCase().includes(tradeFilter)) continue;
    const zip = await resolveWorkOrderPropertyZip(db, row);
    // A service with no resolvable ZIP cannot be placed inside anyone's service area.
    if (!zip || !vendorMatchesZip(zip, radius, profile)) continue;
    matched.push({ record, row });
  }

  const nameByManager = new Map<string, string>();
  for (const managerId of new Set(matched.map((m) => String(m.record.manager_user_id ?? "")).filter(Boolean))) {
    nameByManager.set(managerId, await managerDisplayName(db, managerId));
  }
  const services: PublicBoardServiceView[] = [];
  for (const { record, row } of matched) {
    const view = publicBoardServiceProjection(row, nameByManager.get(String(record.manager_user_id)) ?? "");
    if (view) services.push(view);
  }
  return { ok: true, services };
}

/**
 * Roster row for a vendor the manager did not pick. Built from the vendor's OWN business profile
 * and never from the service's private fields. Contact is HELD: phone / email stay blank on the
 * manager's roster until the vendor's first submitted bid (`revealHeldVendorContact`), except the
 * phone a manager texted a link to, which they already have.
 */
async function ensureHeldVendorRosterRow(
  db: Db,
  input: { managerUserId: string; vendorUserId: string; profile: VendorProfile; origin: BoardOrigin; knownPhone?: string },
): Promise<string | null> {
  const { data: existing } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("manager_user_id", input.managerUserId)
    .eq("vendor_user_id", input.vendorUserId)
    .maybeSingle();
  if (existing?.id) return String(existing.id);

  const trades = Array.isArray(input.profile.trades) ? input.profile.trades : [];
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = {
    id,
    managerUserId: input.managerUserId,
    name: input.profile.business_name?.trim() || "PropLane vendor",
    trade: trades[0] ?? "",
    trades: trades.length ? trades : undefined,
    phone: input.knownPhone?.trim() ?? "",
    email: "",
    notes: "",
    active: true,
    catalogId: `${input.origin === "service_link" ? "service-link" : "work-board"}-${input.vendorUserId}`,
    vendorUserId: input.vendorUserId,
    // Read by the manager's Vendors pipeline ("From your text link" / "From the work board") and
    // cleared, with the contact filled in, by the vendor's first submitted bid.
    origin: input.origin,
    contactHeldUntilBid: true,
    createdAt: now,
    updatedAt: now,
  };
  const { error } = await db
    .from("manager_vendor_records")
    .insert({ id, manager_user_id: input.managerUserId, vendor_user_id: input.vendorUserId, row_data: row, updated_at: now });
  if (error) return null;
  return id;
}

/**
 * Decide #3: the manager sees a board / link vendor's phone and email once they bid. Called from
 * `submitWorkOrderBid` after the bid lands; a no-op for a roster row that was never held. The
 * contact is the vendor's own business-profile contact, written onto the manager's own roster row.
 */
export async function revealHeldVendorContact(
  db: Db,
  input: { vendorUserId: string; managerUserId: string },
): Promise<void> {
  try {
    const { data: rosterRow } = await db
      .from("manager_vendor_records")
      .select("id, row_data")
      .eq("manager_user_id", input.managerUserId)
      .eq("vendor_user_id", input.vendorUserId)
      .maybeSingle();
    const rowData = (rosterRow?.row_data ?? null) as Record<string, unknown> | null;
    if (!rosterRow || !rowData || rowData.contactHeldUntilBid !== true) return;
    const profile = await loadVendorProfile(db, input.vendorUserId);
    const { data: account } = await db.from("profiles").select("email, phone").eq("id", input.vendorUserId).maybeSingle();
    const phone = profile?.work_phone?.trim() || String(rowData.phone ?? "").trim() || String(account?.phone ?? "").trim();
    const email = profile?.work_email?.trim() || String(account?.email ?? "").trim();
    await db
      .from("manager_vendor_records")
      .update({
        row_data: { ...rowData, phone, email, contactHeldUntilBid: false, updatedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq("id", rosterRow.id);
  } catch {
    // The bid is already saved; the contact simply stays held until the next one.
  }
}

/** Create (or reuse) the `sent` offer that makes a service the vendor's own to answer. */
async function openOfferForVendor(
  db: Db,
  input: {
    workOrderId: string;
    managerUserId: string;
    vendorUserId: string;
    directoryId: string;
    row: DemoManagerWorkOrderRow;
    openBidding: boolean;
  },
): Promise<{ ok: true; created: boolean } | BoardActionFailure> {
  const { data: existing } = await db
    .from("work_order_vendor_offers")
    .select("id, status")
    .eq("work_order_id", input.workOrderId)
    .eq("vendor_directory_id", input.directoryId)
    .maybeSingle();
  if (existing?.status === "sent") return { ok: true, created: false };
  // The manager removed this vendor's request: a withdrawn offer is the manager's answer, and the
  // vendor asking again would walk straight past it.
  if (existing?.status === "withdrawn") {
    return { ok: false, status: 403, error: "The manager has closed this request." };
  }
  if (existing && existing.status !== "declined") {
    return { ok: false, status: 409, error: "This service is no longer taking requests." };
  }

  const { count } = await db
    .from("work_order_vendor_offers")
    .select("id", { count: "exact", head: true })
    .eq("work_order_id", input.workOrderId);
  if (!existing && (count ?? 0) >= MAX_BOARD_REQUESTS_PER_SERVICE) {
    return { ok: false, status: 409, error: "This job has all the requests it can take." };
  }

  const settings = await resolveServiceAutomationSettingsForRow(
    db,
    createSettingsScopeCache(),
    input.managerUserId,
    input.row.assignedPropertyId || input.row.propertyId || null,
  ).catch(() => null);
  const expiresAt = settings ? offerExpiresAt(settings, new Date()) : null;
  const now = new Date().toISOString();
  const { error } = await db.from("work_order_vendor_offers").upsert(
    {
      work_order_id: input.workOrderId,
      vendor_directory_id: input.directoryId,
      vendor_user_id: input.vendorUserId,
      manager_user_id: input.managerUserId,
      status: "sent",
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      updated_at: now,
    },
    { onConflict: "work_order_id,vendor_directory_id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };

  if (input.openBidding && !input.row.biddingOpen) {
    const next = { ...input.row, biddingOpen: true, biddingOpenedAt: input.row.biddingOpenedAt ?? now };
    await db
      .from("portal_work_order_records")
      .update({ row_data: stampSmsTestProvenance(next as unknown as Record<string, unknown>), updated_at: now })
      .eq("id", input.workOrderId);
  }
  return { ok: true, created: true };
}

/** Per-vendor request throttle, shared by the board and a redeemed link. */
async function allowVendorRequest(vendorUserId: string): Promise<boolean> {
  return (await rateLimit(`work-board-request:${vendorUserId}`, BOARD_REQUESTS_PER_VENDOR_PER_HOUR, 60 * 60 * 1000)).ok;
}

/**
 * A vendor asks for a published job. `choice` is what they picked on the three-option row (an
 * estimate visit, a bid, a message); it only decides where the UI sends them next - the offer made
 * here is identical for all three, and the existing flow does the rest.
 */
export async function requestBoardJob(
  db: Db,
  actor: { userId: string; role: string },
  input: { ref: string; choice?: BoardChoice },
): Promise<{ ok: true; workOrderId: string; choice: BoardChoice } | BoardActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };
  const ref = input.ref.trim();
  if (!/^pub_[a-f0-9]{32}$/.test(ref)) return { ok: false, status: 404, error: "This job is no longer on the board." };
  if (!(await allowVendorRequest(actor.userId))) {
    return { ok: false, status: 429, error: "Too many requests - try again in a bit." };
  }
  const eligibility = await resolveBoardEligibility(db, actor.userId);
  if (!eligibility.ok) return eligibility;

  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("row_data->>publishRef", ref)
    .is("test_workspace_id", null)
    .maybeSingle();
  const row = (record?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!record || !row || row.published !== true || !serviceIsOpenToNewRequests(record, row)) {
    return { ok: false, status: 404, error: "This job is no longer on the board." };
  }
  const managerUserId = String(record.manager_user_id ?? "");
  if (!managerUserId || managerUserId === actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  // The same trade + area rule the list applied: a ref is not a way around it.
  const category = workOrderCategoryForMarketplace(row, row.category ?? "Maintenance");
  const trades = Array.isArray(eligibility.profile.trades) ? eligibility.profile.trades : [];
  const zip = await resolveWorkOrderPropertyZip(db, row);
  if (!category || !vendorCapabilitiesMatchCategory(trades, category) || !zip || !vendorMatchesZip(zip, 50, eligibility.profile)) {
    return { ok: false, status: 404, error: "This job is no longer on the board." };
  }

  const directoryId = await ensureHeldVendorRosterRow(db, {
    managerUserId,
    vendorUserId: actor.userId,
    profile: eligibility.profile,
    origin: "work_board",
  });
  if (!directoryId) return { ok: false, status: 500, error: "Could not add you to this job." };
  const offer = await openOfferForVendor(db, {
    workOrderId: String(record.id),
    managerUserId,
    vendorUserId: actor.userId,
    directoryId,
    row,
    openBidding: false,
  });
  if (!offer.ok) return offer;
  track("work_board_job_requested", actor.userId, { choice: input.choice ?? "bid" });
  return { ok: true, workOrderId: String(record.id), choice: input.choice ?? "bid" };
}

/* ------------------------------------------------------------------------------------------ */
/* The texted link: public view and redeem                                                    */
/* ------------------------------------------------------------------------------------------ */

/** The public view behind a token, or null for an unknown / expired / revoked / hired-out link. */
export async function resolvePublicServiceByToken(
  db: Db,
  token: string,
): Promise<{ service: PublicServiceView; state: "open" | "closed" } | null> {
  const resolved = await resolveServiceShareToken(db, token);
  if (!resolved) return null;
  const { link } = resolved;
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", link.workOrderId)
    .maybeSingle();
  const row = (record?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!record || !row) return null;
  // Photos follow what the manager chose for THIS link, not what the row says today.
  const forLink: DemoManagerWorkOrderRow = { ...row, publishSharePhotos: link.sharePhotos };
  const service = publicServiceProjection(forLink, await managerDisplayName(db, String(record.manager_user_id ?? "")));
  return { service, state: serviceIsOpenToNewRequests(record, row) ? "open" : "closed" };
}

/**
 * HOOK POINT (vendor-texting-1006): phone verification for a texted link. The vendor is signed in
 * but the phone on their roster row is the one the MANAGER typed; whether the vendor has proved
 * they hold it is vendor texting's verification, not decided or changed here. This stays a no-op
 * returning `verified: false` until that lands, and the roster row records `phoneVerified: false`.
 * Wire it by returning the vendor's verification result for `phone` - nothing else here changes.
 */
export async function serviceLinkPhoneVerificationHook(
  db: Db,
  input: { vendorUserId: string; phone: string },
): Promise<{ verified: boolean }> {
  void db;
  void input;
  return { verified: false };
}

/**
 * A signed-in vendor redeems a texted link: they get a roster row (carrying the phone the link was
 * texted to) and a `sent` offer, then the existing flow runs. The link is bound to its FIRST
 * redeemer - a forwarded link cannot attach the recipient's phone to someone else's account - and
 * redeeming again as the same vendor is an idempotent no-op that returns the same service.
 */
export async function redeemServiceShareLink(
  db: Db,
  actor: { userId: string; role: string },
  input: { token: string; choice?: BoardChoice },
): Promise<{ ok: true; workOrderId: string; choice: BoardChoice; alreadyHeld: boolean } | BoardActionFailure> {
  if (actor.role !== "vendor") return { ok: false, status: 403, error: "Forbidden." };
  if (!(await allowVendorRequest(actor.userId))) {
    return { ok: false, status: 429, error: "Too many requests - try again in a bit." };
  }
  const resolved = await resolveServiceShareToken(db, input.token, { count: false });
  if (!resolved) return { ok: false, status: 404, error: "This link has expired or is no longer valid." };
  const { link } = resolved;
  if (link.redeemedByUserId && link.redeemedByUserId !== actor.userId) {
    return { ok: false, status: 409, error: "This link has already been used." };
  }

  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", link.workOrderId)
    .maybeSingle();
  const row = (record?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!record || !row) return { ok: false, status: 404, error: "This link has expired or is no longer valid." };
  if (!serviceIsOpenToNewRequests(record, row)) {
    return { ok: false, status: 410, error: "This job has already been filled." };
  }
  const managerUserId = String(record.manager_user_id ?? "");
  if (!managerUserId || managerUserId === actor.userId) return { ok: false, status: 403, error: "Forbidden." };

  const eligibility = await resolveBoardEligibility(db, actor.userId);
  // A texted vendor is the manager's own invitation, so a license or insurance is not asked for -
  // but they still need a business profile to hang the roster row on. Finish onboarding first.
  const profile = eligibility.ok
    ? eligibility.profile
    : (await loadVendorProfile(db, actor.userId)) ?? ({ user_id: actor.userId, business_name: "", work_email: "", work_phone: "", trades: [], service_area_zips: [] } as unknown as VendorProfile);

  const directoryId = await ensureHeldVendorRosterRow(db, {
    managerUserId,
    vendorUserId: actor.userId,
    profile,
    origin: "service_link",
    knownPhone: link.recipientPhone,
  });
  if (!directoryId) return { ok: false, status: 500, error: "Could not add you to this job." };

  // Lock the link to this vendor before the offer is made, so two redeemers cannot both pass.
  if (!link.redeemedByUserId) {
    const { data: claimed } = await db
      .from("service_share_links")
      .update({ redeemed_by_user_id: actor.userId, redeemed_at: new Date().toISOString() })
      .eq("id", link.id)
      .is("redeemed_by_user_id", null)
      .select("id")
      .maybeSingle();
    if (!claimed) {
      const { data: again } = await db.from("service_share_links").select("redeemed_by_user_id").eq("id", link.id).maybeSingle();
      if (String(again?.redeemed_by_user_id ?? "") !== actor.userId) {
        return { ok: false, status: 409, error: "This link has already been used." };
      }
    }
  }

  const verification = await serviceLinkPhoneVerificationHook(db, { vendorUserId: actor.userId, phone: link.recipientPhone });
  if (verification.verified) {
    const { data: roster } = await db.from("manager_vendor_records").select("row_data").eq("id", directoryId).maybeSingle();
    if (roster?.row_data) {
      await db
        .from("manager_vendor_records")
        .update({ row_data: { ...(roster.row_data as Record<string, unknown>), phoneVerified: true } })
        .eq("id", directoryId);
    }
  }

  const offer = await openOfferForVendor(db, {
    workOrderId: String(record.id),
    managerUserId,
    vendorUserId: actor.userId,
    directoryId,
    row,
    // The manager texted this job for bids, so bidding opens even when it was never published.
    openBidding: true,
  });
  if (!offer.ok) return offer;
  track("service_link_redeemed", actor.userId, { choice: input.choice ?? "bid" });
  return { ok: true, workOrderId: String(record.id), choice: input.choice ?? "bid", alreadyHeld: !offer.created };
}
