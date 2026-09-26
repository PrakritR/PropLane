/**
 * C152 "Open" tab: a genuine cross-workspace job marketplace, additive to the
 * existing single-vendor Phase 2 bidding flow (docs/agents/vendor-portal.md).
 * A manager publishes a `work_order_open_listings` row carrying ONLY the
 * fields safe to show any vendor on any workspace; bidding itself reuses the
 * existing `work_order_bids` table/routes unchanged
 * (`src/lib/work-order-bids.server.ts`'s `resolveVendorWorkOrderAccess` grants
 * access to any vendor once an open listing exists for the work order).
 *
 * Every write here re-derives ownership server-side (the work order's own
 * `manager_user_id`) — a client-supplied id is never trusted as authorization.
 */
import { track } from "@/lib/analytics/posthog";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import type { WorkOrderActor, WorkOrderActionFailure } from "@/lib/work-order-bids.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type OpenListingRecord = {
  id: string;
  work_order_id: string;
  manager_user_id: string;
  trade: string;
  area: string;
  description: string;
  timeframe: string | null;
  budget_min_cents: number | null;
  budget_max_cents: number | null;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The manager's own view of their listing — every stored field. */
export type OwnOpenListingJson = {
  id: string;
  workOrderId: string;
  trade: string;
  area: string;
  description: string;
  timeframe: string | null;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
};

/**
 * What ANY vendor on ANY workspace may see. Explicit allowlist, same shape
 * `publicListingProjection` uses for public rental listings — everything the
 * underlying work order carries (address, unit, resident identity, access
 * notes, photos) is deliberately absent because it is never read here.
 */
export type PublicOpenListingJson = {
  id: string;
  workOrderId: string;
  trade: string;
  area: string;
  description: string;
  timeframe: string | null;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  openedAt: string;
};

function toOwnJson(row: OpenListingRecord): OwnOpenListingJson {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    trade: row.trade,
    area: row.area,
    description: row.description,
    timeframe: row.timeframe,
    budgetMinCents: row.budget_min_cents,
    budgetMaxCents: row.budget_max_cents,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

/** The public projection — called ONLY on rows already queried with `status = 'open'`. */
export function publicOpenListingProjection(row: OpenListingRecord): PublicOpenListingJson {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    trade: row.trade,
    area: row.area,
    description: row.description,
    timeframe: row.timeframe,
    budgetMinCents: row.budget_min_cents,
    budgetMaxCents: row.budget_max_cents,
    openedAt: row.opened_at,
  };
}

const MAX_AREA_LEN = 120;
const MAX_DESCRIPTION_LEN = 1000;
const MAX_TIMEFRAME_LEN = 40;

function normalizeBudgetCents(value: unknown): number | null | { error: string } {
  if (value === undefined || value === null || value === "") return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return { error: "Enter a valid budget amount." };
  return n;
}

export type OpenListingInput = {
  workOrderId?: string;
  trade?: string;
  area?: string;
  description?: string;
  timeframe?: string;
  budgetMinCents?: number | string;
  budgetMaxCents?: number | string;
};

/** Manager (or admin) publishes — or republishes/edits — an open listing for their own work order. */
export async function openWorkOrderForBidding(
  db: Db,
  actor: WorkOrderActor,
  body: OpenListingInput,
): Promise<{ ok: true; listing: OwnOpenListingJson } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const trade = String(body.trade ?? "").trim().slice(0, 60);
  const area = String(body.area ?? "").trim().slice(0, MAX_AREA_LEN);
  const description = String(body.description ?? "").trim().slice(0, MAX_DESCRIPTION_LEN);
  const timeframeRaw = String(body.timeframe ?? "").trim().slice(0, MAX_TIMEFRAME_LEN);
  const timeframe = timeframeRaw || null;

  if (!trade || !(VENDOR_TRADE_OPTIONS as readonly string[]).includes(trade)) {
    return { ok: false, status: 400, error: "Choose a trade/category." };
  }
  if (!area) return { ok: false, status: 400, error: "Enter a city or area." };
  if (!description) return { ok: false, status: 400, error: "Write a short description for the listing." };

  const budgetMinCents = normalizeBudgetCents(body.budgetMinCents);
  if (budgetMinCents !== null && typeof budgetMinCents === "object") {
    return { ok: false, status: 400, error: budgetMinCents.error };
  }
  const budgetMaxCents = normalizeBudgetCents(body.budgetMaxCents);
  if (budgetMaxCents !== null && typeof budgetMaxCents === "object") {
    return { ok: false, status: 400, error: budgetMaxCents.error };
  }
  if (budgetMinCents !== null && budgetMaxCents !== null && budgetMinCents > budgetMaxCents) {
    return { ok: false, status: 400, error: "Minimum budget can't be more than the maximum." };
  }

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  const managerUserId = String(workOrder.manager_user_id);
  if (!actor.admin && managerUserId !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("work_order_open_listings")
    .upsert(
      {
        work_order_id: workOrderId,
        manager_user_id: managerUserId,
        trade,
        area,
        description,
        timeframe,
        budget_min_cents: budgetMinCents,
        budget_max_cents: budgetMaxCents,
        status: "open",
        opened_at: now,
        closed_at: null,
        updated_at: now,
      },
      { onConflict: "work_order_id" },
    )
    .select("*")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };

  track("work_order_open_listing_opened", actor.userId, { work_order_id: workOrderId });
  return { ok: true, listing: toOwnJson(data as OpenListingRecord) };
}

/** Manager (or admin) closes their own open listing. Idempotent no-op if already closed. */
export async function closeWorkOrderBidding(
  db: Db,
  actor: WorkOrderActor,
  body: { workOrderId?: string },
): Promise<{ ok: true; listing: OwnOpenListingJson | null } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const workOrderId = String(body.workOrderId ?? "").trim();
  if (!workOrderId) return { ok: false, status: 400, error: "Work order id required." };

  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && String(workOrder.manager_user_id) !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("work_order_open_listings")
    .update({ status: "closed", closed_at: now, updated_at: now })
    .eq("work_order_id", workOrderId)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) {
    // Already closed or never opened — read back whatever is there so the UI can sync.
    const { data: existing } = await db
      .from("work_order_open_listings")
      .select("*")
      .eq("work_order_id", workOrderId)
      .maybeSingle();
    return { ok: true, listing: existing ? toOwnJson(existing as OpenListingRecord) : null };
  }

  track("work_order_open_listing_closed", actor.userId, { work_order_id: workOrderId });
  return { ok: true, listing: toOwnJson(data as OpenListingRecord) };
}

/** Manager's own view of their listing (any status), for the service record page. */
export async function getOwnOpenListing(
  db: Db,
  actor: WorkOrderActor,
  workOrderId: string,
): Promise<{ ok: true; listing: OwnOpenListingJson | null } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "manager" && actor.role !== "pro") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const { data: workOrder } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!workOrder) return { ok: false, status: 403, error: "Forbidden." };
  if (!actor.admin && String(workOrder.manager_user_id) !== actor.userId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const { data, error } = await db
    .from("work_order_open_listings")
    .select("*")
    .eq("work_order_id", workOrderId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, listing: data ? toOwnJson(data as OpenListingRecord) : null };
}

const MAX_BROWSE_LIMIT = 50;
const DEFAULT_BROWSE_LIMIT = 20;

/** Vendor (any workspace) browses open listings, filterable by trade/area, paginated. */
export async function browseOpenListings(
  db: Db,
  actor: WorkOrderActor,
  opts: { trade?: string; area?: string; offset?: number; limit?: number },
): Promise<{ ok: true; listings: PublicOpenListingJson[]; hasMore: boolean } | WorkOrderActionFailure> {
  if (!actor.admin && actor.role !== "vendor") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0)) || 0);
  const limit = Math.min(MAX_BROWSE_LIMIT, Math.max(1, Math.floor(Number(opts.limit ?? DEFAULT_BROWSE_LIMIT)) || DEFAULT_BROWSE_LIMIT));

  let query = db.from("work_order_open_listings").select("*").eq("status", "open");

  const trade = opts.trade?.trim();
  if (trade && (VENDOR_TRADE_OPTIONS as readonly string[]).includes(trade)) {
    query = query.eq("trade", trade);
  }
  const area = opts.area?.trim().slice(0, MAX_AREA_LEN);
  if (area) query = query.ilike("area", `%${area}%`);

  // Filters first, ordering and pagination last — fetch one extra row to detect hasMore.
  const { data, error } = await query.order("opened_at", { ascending: false }).range(offset, offset + limit);
  if (error) return { ok: false, status: 500, error: error.message };

  const rows = (data ?? []) as OpenListingRecord[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { ok: true, listings: page.map(publicOpenListingProjection), hasMore };
}

/** Best-effort: close a work order's open listing once it has been assigned (bid accepted). */
export async function closeOpenListingBestEffort(db: Db, workOrderId: string): Promise<void> {
  try {
    await db
      .from("work_order_open_listings")
      .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("work_order_id", workOrderId)
      .eq("status", "open");
  } catch {
    /* best effort only — the accepted bid itself is the source of truth */
  }
}

/** True when this work order currently has an OPEN marketplace listing — used by
 * `resolveVendorWorkOrderAccess` to admit a vendor nobody specifically offered the job to. */
export async function hasOpenListing(db: Db, workOrderId: string): Promise<boolean> {
  const { data } = await db
    .from("work_order_open_listings")
    .select("id")
    .eq("work_order_id", workOrderId)
    .eq("status", "open")
    .maybeSingle();
  return Boolean(data);
}
