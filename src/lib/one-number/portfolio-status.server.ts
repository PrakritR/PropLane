import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { coManagerModuleAllowed, type CoManagerPermissionId } from "@/lib/co-manager-permissions";
import type { HouseholdCharge } from "@/lib/household-charges";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { parseMoneyAmount } from "@/lib/parse-money";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import { PLANNED_RECORD_ID } from "@/lib/tour-inquiry.server";
import type { HouseStatus, PortfolioStatus } from "@/lib/one-number/portfolio-status";
import { monthOfDayKey, pacificClock, shiftDayKey, summarizeRentForMonth } from "@/lib/one-number/ops-text";
import type { AgentContext } from "@/lib/tools/context";
import { ownedSingletonItems, readSingletonItems } from "@/lib/tools/domains/calendar";

/**
 * `get_portfolio_status`: per-house occupancy, this month's rent, open services, the next tour and
 * leases ending soon, for ONE workspace and the houses a person may see. One reader behind the
 * PropLane-line status text and the manager assistant tool, so the two can never disagree. Every
 * figure comes from the same pure report functions the portal and the 8am digest use
 * (`summarizeRentForMonth`, `roomAvailabilityForRange`, the lease pipeline normalizer); nothing is
 * counted by a model.
 *
 * The reader takes a `PortfolioScope` (data owner, workspace, houses, per-module read test) and
 * never a raw id from a request: a caller builds the scope from a proven membership. A part that
 * fails to read comes back `null`, never zero.
 */

export type PortfolioModule = Extract<CoManagerPermissionId, "properties" | "payments" | "services" | "leases" | "calendar">;

export type PortfolioScope = {
  db: SupabaseClient;
  /** `manager_user_id` on every row read: the workspace owner. */
  ownerUserId: string;
  workspaceId: string;
  workspaceName: string;
  /** True when a house with no `workspace_id` belongs to this workspace (the owner's default one). */
  workspaceIsDefault: boolean;
  /** Houses this person reaches; null = every house in the workspace. */
  propertyIds: readonly string[] | null;
  /** May this person read `module` facts for the house? Owners read everything; a teammate reads what was granted. */
  canRead: (propertyId: string, module: PortfolioModule) => boolean;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const PAGE = 1000;
/** Houses whose rooms are checked against the calendar (one read each). */
const MAX_AVAILABILITY_HOUSES = 12;
const LEASE_WINDOW_DAYS = 60;
const RECENT_PAYMENT_DAYS = 7;

async function pagedRows(db: SupabaseClient, table: string, columns: string, ownerUserId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .eq("manager_user_id", ownerUserId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} unreadable`);
    const rows = (data ?? []) as unknown as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function houseTitle(rec: Row): string {
  const src = Object.keys(obj(rec.property_data)).length ? obj(rec.property_data) : obj(rec.row_data);
  return str(src.title) || str(src.buildingName) || str(src.name) || str(src.address) || str(rec.id);
}

function houseSubmission(rec: Row): unknown {
  return obj(rec.property_data).listingSubmission ?? obj(rec.row_data).submission ?? null;
}

/** The houses in this scope: the workspace's, narrowed to the person's, drafts left out. */
export async function loadScopedHouses(scope: PortfolioScope): Promise<Array<{ id: string; title: string; submission: unknown }>> {
  const { data, error } = await scope.db
    .from("manager_property_records")
    .select("id, workspace_id, row_data, property_data")
    .eq("manager_user_id", scope.ownerUserId)
    .limit(1000);
  if (error) throw new Error("houses unreadable");
  const wanted = scope.propertyIds ? new Set(scope.propertyIds) : null;
  const out: Array<{ id: string; title: string; submission: unknown }> = [];
  for (const rec of (data ?? []) as unknown as Row[]) {
    const id = str(rec.id);
    const houseWorkspace = str(rec.workspace_id);
    if (houseWorkspace ? houseWorkspace !== scope.workspaceId : !scope.workspaceIsDefault) continue;
    if (wanted && !wanted.has(id)) continue;
    if (str(obj(rec.row_data).status) === "draft" || str(obj(rec.property_data).status) === "draft") continue;
    if (!scope.canRead(id, "properties")) continue;
    out.push({ id, title: houseTitle(rec), submission: houseSubmission(rec) });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function cents(label: string | undefined): number {
  return Math.round(parseMoneyAmount(label ?? "") * 100);
}

function houseOf(...candidates: unknown[]): string {
  for (const c of candidates) if (str(c)) return str(c);
  return "";
}

/** "Tue Oct 21" in Pacific time for an instant. */
function tourDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

async function inChunks<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

export async function readPortfolioStatus(scope: PortfolioScope, options: { now?: Date } = {}): Promise<PortfolioStatus> {
  const now = options.now ?? new Date();
  const today = pacificCalendarDateYmd(now);
  const month = monthOfDayKey(today);
  const unreadable = new Set<string>();

  let houses: Awaited<ReturnType<typeof loadScopedHouses>>;
  try {
    houses = await loadScopedHouses(scope);
  } catch {
    return { month, workspaceName: scope.workspaceName, houses: [], unreadable: ["your houses"], restricted: [] };
  }

  const settle = async <T,>(part: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch {
      unreadable.add(part);
      return null;
    }
  };

  const [charges, orders, requests, leaseRows, planned] = await Promise.all([
    settle("rent", async () => (await pagedRows(scope.db, "portal_household_charge_records", "id, row_data", scope.ownerUserId)).map((r) => r.row_data as HouseholdCharge)),
    settle("services", () => pagedRows(scope.db, "portal_work_order_records", "id, property_id, assigned_property_id, row_data", scope.ownerUserId)),
    settle("services", () => pagedRows(scope.db, "portal_service_request_records", "id, property_id, status, row_data", scope.ownerUserId)),
    settle("leases", () => pagedRows(scope.db, "portal_lease_pipeline_records", "id, property_id, row_data", scope.ownerUserId)),
    settle("tours", async () =>
      ownedSingletonItems(await readSingletonItems({ db: scope.db } as unknown as AgentContext, PLANNED_RECORD_ID), scope.ownerUserId),
    ),
  ]);

  const availability = new Map<string, { rooms: number; vacant: number } | null>();
  const availabilityHouses = houses.slice(0, MAX_AVAILABILITY_HOUSES).filter((h) => scope.canRead(h.id, "properties"));
  await inChunks(availabilityHouses, 4, async (house) => {
    try {
      const result = await roomAvailabilityForRange({ propertyId: house.id, moveIn: today }, { submission: house.submission });
      availability.set(house.id, result.ok ? { rooms: result.rooms.length, vacant: result.rooms.filter((r) => r.available === true).length } : null);
    } catch {
      availability.set(house.id, null);
    }
  });
  if (availabilityHouses.some((h) => availability.get(h.id) === null)) unreadable.add("room availability");

  const leaseHorizon = shiftDayKey(today, LEASE_WINDOW_DAYS);
  const recentCutoff = now.getTime() - RECENT_PAYMENT_DAYS * 86_400_000;
  const nowIso = now.toISOString();

  const rows: HouseStatus[] = houses.map((house) => {
    const id = house.id;
    const av = availability.get(id);

    let rentCollectedCents: number | null = null;
    let rentOwedCents: number | null = null;
    let unpaidResidents: number | null = null;
    let paidLast7: HouseStatus["paidLast7"] = null;
    if (charges && scope.canRead(id, "payments")) {
      const mine = charges.filter((c) => str(c?.propertyId) === id);
      const rent = summarizeRentForMonth(mine, month);
      rentCollectedCents = rent.paidCents;
      rentOwedCents = rent.unpaidCents;
      unpaidResidents = rent.unpaidCount;
      const recent = mine.filter((c) => c.status === "paid" && c.paidAt && Date.parse(c.paidAt) >= recentCutoff);
      paidLast7 = { count: recent.length, cents: recent.reduce((n, c) => n + (c.paidAmountCents && c.paidAmountCents > 0 ? c.paidAmountCents : cents(c.amountLabel)), 0) };
    }

    let openServices: number | null = null;
    if (orders && requests && scope.canRead(id, "services")) {
      const open = orders.filter((o) => {
        const data = obj(o.row_data);
        if (houseOf(o.assigned_property_id, o.property_id, data.assignedPropertyId, data.propertyId) !== id) return false;
        return data.bucket === "open" || data.bucket === "scheduled";
      }).length;
      const pending = requests.filter((r) => houseOf(r.property_id, obj(r.row_data).propertyId) === id && str(obj(r.row_data).status || r.status) === "pending").length;
      openServices = open + pending;
    }

    let nextTour: HouseStatus["nextTour"] = undefined;
    if (planned && scope.canRead(id, "calendar")) {
      const upcoming = planned
        .filter((ev) => str(ev.kind) === "tour" && !str(ev.canceledAt) && str(ev.propertyId) === id && str(ev.start) > nowIso)
        .sort((a, b) => str(a.start).localeCompare(str(b.start)))[0];
      nextTour = upcoming ? { day: tourDay(str(upcoming.start)), time: pacificClock(str(upcoming.start)), startsAt: str(upcoming.start) } : null;
    }

    let leasesEnding: HouseStatus["leasesEnding"] = null;
    if (leaseRows && scope.canRead(id, "leases")) {
      const ends: string[] = [];
      for (const rec of leaseRows) {
        if (houseOf(rec.property_id, obj(rec.row_data).propertyId) !== id) continue;
        const row = normalizeLeasePipelineRow(rec.row_data);
        if (String(row.status ?? row.stageLabel ?? "").toLowerCase() !== "fully signed") continue;
        const end = str(row.application?.leaseEnd).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end >= today && end <= leaseHorizon) ends.push(end);
      }
      ends.sort();
      leasesEnding = { count: ends.length, earliest: ends[0] ?? null };
    }

    return {
      propertyId: id,
      title: house.title,
      rooms: av ? av.rooms : null,
      vacantRooms: av ? av.vacant : null,
      rentCollectedCents,
      rentOwedCents,
      unpaidResidents,
      paidLast7,
      openServices,
      nextTour,
      leasesEnding,
    };
  });

  const restricted: string[] = [];
  const withheld = (module: PortfolioModule) => houses.some((h) => !scope.canRead(h.id, module));
  if (withheld("payments")) restricted.push("rent");
  if (withheld("services")) restricted.push("services");
  if (withheld("leases")) restricted.push("leases");
  if (withheld("calendar")) restricted.push("tours");
  return { month, workspaceName: scope.workspaceName, houses: rows, unreadable: [...unreadable], restricted };
}

/** Build a scope from a manager-SMS / portal agent context (owner, combined or delegated access). */
export async function portfolioScopeFromAgentContext(ctx: AgentContext): Promise<PortfolioScope | null> {
  const workspace = ctx.workspace;
  const access = ctx.managerSmsAccess;
  const ownerUserId = access?.mode === "delegated" ? access.workNumberOwnerId : ctx.landlordId;
  if (!ownerUserId) return null;
  let workspaceId = workspace?.id?.trim() || "";
  let workspaceName = workspace?.name ?? "";
  let workspaceIsDefault = workspace?.isDefault ?? true;
  if (!workspaceId) {
    const { data } = await ctx.db.from("portal_workspaces").select("id, name, is_default").eq("owner_user_id", ownerUserId).eq("is_default", true).maybeSingle();
    workspaceId = str((data as Row | null)?.id);
    workspaceName = str((data as Row | null)?.name);
    workspaceIsDefault = true;
  }
  if (!workspaceId) return null;
  const delegated = access?.mode === "delegated";
  const permissions = access?.permissionsByOwner?.[ownerUserId];
  return {
    db: ctx.db as unknown as SupabaseClient,
    ownerUserId,
    workspaceId,
    workspaceName,
    workspaceIsDefault,
    propertyIds: delegated ? access!.assignedPropertyIds : workspace?.narrowing ? workspace.propertyIds : null,
    canRead: (propertyId, module) => (delegated ? coManagerModuleAllowed(permissions, propertyId, module, "read") : true),
  };
}
