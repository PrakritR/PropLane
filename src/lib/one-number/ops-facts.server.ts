import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { propertyInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import type { HouseholdCharge } from "@/lib/household-charges";
import { pacificEndOfDayMs, pacificStartOfDayMs } from "@/lib/pacific-time";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { INQUIRIES_RECORD_ID, PLANNED_RECORD_ID, windowsFromInquiry } from "@/lib/tour-inquiry.server";
import type { AgentContext } from "@/lib/tools/context";
import { ownedSingletonItems, readSingletonItems } from "@/lib/tools/domains/calendar";
import { loadAllManagerRows } from "@/lib/tools/domains/load-manager-rows";
import { pacificClock, summarizeRentForMonth, type RentStatus } from "@/lib/one-number/ops-text";

/**
 * W8: the facts a manager asks for by text and the 8am digest reports. One reader per fact, each
 * scoped by the context it is given (the workspace the number belongs to, plus a teammate's
 * assigned houses), so "who hasn't paid" over SMS and the digest can never disagree and neither
 * can reach another team's rows.
 */

type Obj = Record<string, unknown>;
const str = (o: Obj, k: string): string => (typeof o[k] === "string" ? (o[k] as string).trim() : "");

/** True when this turn may see an event on `propertyId`: workspace first, then a delegated teammate's houses. */
export function opsContextSeesProperty(ctx: AgentContext, propertyId: string | null | undefined): boolean {
  if (!propertyInAgentWorkspace(ctx.workspace, propertyId)) return false;
  const access = ctx.managerSmsAccess;
  if (access?.mode === "delegated") {
    const id = propertyId?.trim();
    return Boolean(id) && access.assignedPropertyIds.includes(id!);
  }
  return true;
}

export type TourLine = { id: string; time: string; who: string; house: string; startsAt: string };

export type ToursOnDay = { day: string; confirmed: TourLine[]; requests: TourLine[] };

function dayWindow(dayKey: string): { from: number; to: number } | null {
  const from = pacificStartOfDayMs(dayKey);
  const to = pacificEndOfDayMs(dayKey);
  return from == null || to == null ? null : { from, to };
}

/** Confirmed tours (and open tour requests) starting on one Pacific day. Another team's tours never appear. */
export async function toursOnDay(ctx: AgentContext, dayKey: string, propertyId?: string | null): Promise<ToursOnDay> {
  const window = dayWindow(dayKey);
  const empty: ToursOnDay = { day: dayKey, confirmed: [], requests: [] };
  if (!window) return empty;
  const inDay = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= window.from && t < window.to;
  };
  const wanted = propertyId?.trim() || "";
  const [planned, inquiries] = await Promise.all([
    readSingletonItems(ctx, PLANNED_RECORD_ID),
    readSingletonItems(ctx, INQUIRIES_RECORD_ID),
  ]);

  const confirmed: TourLine[] = ownedSingletonItems(planned, ctx.landlordId)
    .filter((ev) => str(ev, "kind") === "tour" && !str(ev, "canceledAt"))
    .filter((ev) => inDay(str(ev, "start")) && opsContextSeesProperty(ctx, str(ev, "propertyId")))
    .filter((ev) => !wanted || str(ev, "propertyId") === wanted)
    .map((ev) => ({
      id: str(ev, "id"),
      startsAt: str(ev, "start"),
      time: pacificClock(str(ev, "start")),
      who: str(ev, "attendeeName") || "Guest",
      house: str(ev, "propertyTitle"),
    }));

  const requests: TourLine[] = [];
  for (const item of ownedSingletonItems(inquiries, ctx.landlordId)) {
    if (str(item, "kind") !== "tour") continue;
    if (str(item, "status") && str(item, "status") !== "pending") continue;
    if (!opsContextSeesProperty(ctx, str(item, "propertyId"))) continue;
    if (wanted && str(item, "propertyId") !== wanted) continue;
    const first = windowsFromInquiry(item as never)[0] as { start?: string } | undefined;
    if (!first?.start || !inDay(first.start)) continue;
    requests.push({ id: str(item, "id"), startsAt: first.start, time: pacificClock(first.start), who: str(item, "name") || "Guest", house: str(item, "propertyTitle") });
  }
  const byTime = (a: TourLine, b: TourLine) => a.startsAt.localeCompare(b.startsAt);
  return { day: dayKey, confirmed: confirmed.sort(byTime), requests: requests.sort(byTime) };
}

/** Rent for one Pacific month over the charges this context may see, optionally one house. */
export async function rentStatusFor(ctx: AgentContext, month: string, propertyId?: string | null): Promise<RentStatus> {
  const charges = await loadAllManagerRows<HouseholdCharge>(
    ctx,
    "portal_household_charge_records",
    (row) => row as HouseholdCharge,
    "payments",
  );
  const wanted = propertyId?.trim() || "";
  return summarizeRentForMonth(wanted ? charges.filter((c) => c.propertyId === wanted) : charges, month);
}

/** Open services: maintenance not yet done (open or scheduled) plus add-on requests still pending. */
export async function openServiceCount(ctx: AgentContext): Promise<number> {
  const [orders, requests] = await Promise.all([
    loadAllManagerRows<DemoManagerWorkOrderRow>(ctx, "portal_work_order_records", (row) => row as DemoManagerWorkOrderRow, "services"),
    loadAllManagerRows<ServiceRequest>(ctx, "portal_service_request_records", (row) => row as ServiceRequest, "services"),
  ]);
  return (
    orders.filter((o) => o.bucket === "open" || o.bucket === "scheduled").length +
    requests.filter((r) => r.status === "pending").length
  );
}

/**
 * Prospects who first texted this workspace since `sinceIso`. The count is the workspace's own
 * prospect contacts (stamped with its id), so another team's leads are not in it.
 */
export async function newLeadCount(ctx: AgentContext, sinceIso: string): Promise<number> {
  const workspaceId = ctx.workspace?.id?.trim();
  if (!workspaceId) return 0;
  const { count, error } = await ctx.db
    .from("manager_sms_contacts")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", ctx.landlordId)
    .eq("workspace_id", workspaceId)
    .eq("counterparty_role", "prospect")
    .gte("created_at", sinceIso);
  if (error) return 0;
  return count ?? 0;
}
