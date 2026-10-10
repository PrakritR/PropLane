import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderActor } from "@/lib/work-order-bids.server";
import type { VendorAgentContext } from "../../vendor-context";
import { wrapUntrustedContent } from "../../untrusted-content";

/**
 * A work order the vendor may see: one they're currently assigned to
 * (`vendor_user_id = ctx.userId`), or one a manager sent them a still-open
 * consultation/quote offer for — the same visibility rule as the vendor GET
 * branch of /api/portal-work-orders.
 */
export type VendorWorkOrder = {
  id: string;
  managerUserId: string | null;
  row: DemoManagerWorkOrderRow;
  assignment: "assigned" | "offered";
};

/** The vendor's directory-row ids across every manager whose directory lists them. */
export async function vendorDirectoryIds(ctx: VendorAgentContext): Promise<string[]> {
  const { data, error } = await ctx.db
    .from("manager_vendor_records")
    .select("id")
    .eq("vendor_user_id", ctx.userId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: { id: unknown }) => String(row.id ?? "")).filter(Boolean);
}

/** Work-order ids with a live ("sent") offer to this vendor, by user id or directory id. */
async function offeredWorkOrderIds(ctx: VendorAgentContext): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data: byUser } = await ctx.db
    .from("work_order_vendor_offers")
    .select("work_order_id")
    .eq("vendor_user_id", ctx.userId)
    .eq("status", "sent");
  for (const offer of byUser ?? []) ids.add(String(offer.work_order_id));

  const directoryIds = await vendorDirectoryIds(ctx);
  if (directoryIds.length > 0) {
    const { data: byDirectory } = await ctx.db
      .from("work_order_vendor_offers")
      .select("work_order_id")
      .in("vendor_directory_id", directoryIds)
      .eq("status", "sent");
    for (const offer of byDirectory ?? []) ids.add(String(offer.work_order_id));
  }
  return ids;
}

/**
 * Every work order visible to this vendor (assigned first, then offered),
 * mirroring vendorScopedWorkOrderRows in /api/portal-work-orders.
 */
export async function loadVendorWorkOrders(ctx: VendorAgentContext): Promise<VendorWorkOrder[]> {
  const { data: assigned, error } = await ctx.db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data, updated_at")
    .eq("vendor_user_id", ctx.userId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);

  const byId = new Map<string, VendorWorkOrder>();
  for (const record of assigned ?? []) {
    const row = record.row_data as DemoManagerWorkOrderRow | null;
    if (row) {
      byId.set(String(record.id), {
        id: String(record.id),
        managerUserId: (record.manager_user_id as string | null) ?? null,
        row,
        assignment: "assigned",
      });
    }
  }

  const offered = await offeredWorkOrderIds(ctx);
  const missingIds = [...offered].filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const { data: offeredRows } = await ctx.db
      .from("portal_work_order_records")
      .select("id, manager_user_id, row_data")
      .in("id", missingIds);
    for (const record of offeredRows ?? []) {
      const row = record.row_data as DemoManagerWorkOrderRow | null;
      if (row) {
        byId.set(String(record.id), {
          id: String(record.id),
          managerUserId: (record.manager_user_id as string | null) ?? null,
          row,
          assignment: "offered",
        });
      }
    }
  }

  return [...byId.values()];
}

/**
 * Resolve ONE work order the vendor may act on, by id — assigned to them, or
 * carrying a live offer to them. Returns null for anything else (including
 * other vendors' work orders), so callers can never touch a foreign record.
 */
export async function resolveVendorWorkOrderTarget(
  ctx: VendorAgentContext,
  workOrderId: string,
): Promise<VendorWorkOrder | null> {
  const id = workOrderId.trim();
  if (!id) return null;
  const { data: record, error } = await ctx.db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!record) return null;
  const row = (record.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!row) return null;
  const base = {
    id,
    managerUserId: (record.manager_user_id as string | null) ?? null,
    row,
  };
  if (record.vendor_user_id === ctx.userId) return { ...base, assignment: "assigned" };

  // Not assigned: only visible while the vendor holds a live offer for it.
  const { data: offerByUser } = await ctx.db
    .from("work_order_vendor_offers")
    .select("id")
    .eq("work_order_id", id)
    .eq("vendor_user_id", ctx.userId)
    .eq("status", "sent")
    .maybeSingle();
  if (offerByUser) return { ...base, assignment: "offered" };

  const directoryIds = await vendorDirectoryIds(ctx);
  if (directoryIds.length > 0) {
    const { data: offerByDirectory } = await ctx.db
      .from("work_order_vendor_offers")
      .select("id")
      .eq("work_order_id", id)
      .in("vendor_directory_id", directoryIds)
      .eq("status", "sent")
      .limit(1);
    if (offerByDirectory?.length) return { ...base, assignment: "offered" };
  }
  return null;
}

export type OwnBid = {
  id: string;
  status: "submitted" | "accepted" | "declined";
  quote_mode: "upfront" | "after_consultation";
  consultation_visit_at: string | null;
  amount_cents: number | null;
  materials_cents: number;
  proposed_time: string | null;
};

/** The vendor's own bid on a work order (unique per work_order_id + vendor_user_id), or null. */
export async function findOwnBid(ctx: VendorAgentContext, workOrderId: string): Promise<OwnBid | null> {
  const { data, error } = await ctx.db
    .from("work_order_bids")
    .select("id, status, quote_mode, consultation_visit_at, amount_cents, materials_cents, proposed_time")
    .eq("work_order_id", workOrderId)
    .eq("vendor_user_id", ctx.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OwnBid | null) ?? null;
}

/**
 * The acting identity passed to the shared work-order-bids.server functions.
 * Always the authenticated vendor — never model input. fullName is read from
 * the vendor's own profile (used in manager-facing notifications).
 */
export async function vendorWorkOrderActor(ctx: VendorAgentContext): Promise<WorkOrderActor> {
  const { data } = await ctx.db.from("profiles").select("full_name").eq("id", ctx.userId).maybeSingle();
  return {
    userId: ctx.userId,
    email: ctx.email,
    fullName: String(data?.full_name ?? "").trim(),
    admin: false,
    role: "vendor",
  };
}

export type LinkedManagerContact = { id: string; email: string; name: string };

/**
 * Profiles of the managers linked to this vendor (ids come from the
 * authenticated context, never from model input).
 */
export async function linkedManagerContacts(ctx: VendorAgentContext): Promise<LinkedManagerContact[]> {
  if (ctx.managerIds.length === 0) return [];
  const { data, error } = await ctx.db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", ctx.managerIds);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row: { id: unknown; email: unknown; full_name: unknown }) => {
      const email = String(row.email ?? "").trim().toLowerCase();
      return {
        id: String(row.id ?? "").trim(),
        email,
        name: String(row.full_name ?? "").trim() || email,
      };
    })
    .filter((c: LinkedManagerContact) => c.id && c.email);
}

/**
 * Stable content hash (djb2) for audit dedupe keys built from free text or
 * amounts — the text itself never reaches the audit table.
 */
export function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Wrap other-party-authored free text (resident descriptions, manager notes)
 * so the model treats it as quoted data, never as instructions. Returns null
 * for empty text so projections stay compact.
 */
export function untrustedText(source: string, text: string | null | undefined): { untrustedContent: string } | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return wrapUntrustedContent("MESSAGE", source, trimmed);
}

/** Cents → "$123.45" label for previews and replies. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
