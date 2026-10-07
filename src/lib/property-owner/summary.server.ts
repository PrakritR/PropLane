import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { grantedHouses, type OwnerGrant } from "@/lib/property-owner/access.server";
import {
  monthEnd,
  monthStart,
  ownerMonthKeys,
  parseOwnerPeriod,
  type OwnerStatementRow,
  type OwnerStatements,
  type OwnerSummary,
  type OwnerUnitRow,
} from "@/lib/property-owner/projection";
import {
  buildOwnerSummary,
  profitabilityRowFromCells,
  type OwnerHouseInputs,
  type ProfitabilityMonthRow,
} from "@/lib/property-owner/summary";
import { humanizeUnitLabel, loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { queryOccupancyReport } from "@/lib/reports/formal-documents/scoped-queries";
import { dollarsToCents } from "@/lib/reports/money";
import { queryOwnerStatement } from "@/lib/reports/queries/ap-reports";
import { queryProfitability } from "@/lib/reports/profitability.server";

/** A request named a house the owner was not granted (or a period that is not a month). */
export class OwnerScopeError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "OwnerScopeError";
  }
}

const RENT_PROFILE_LIMIT = 500;

function groupByManager(houses: { propertyId: string; managerUserId: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const house of houses) {
    const list = out.get(house.managerUserId) ?? [];
    list.push(house.propertyId);
    out.set(house.managerUserId, list);
  }
  return out;
}

/** Rent charged per house per month: `ledger_entries` charge rows in rent income, by due date. */
async function loadRentDue(
  db: SupabaseClient,
  managerUserId: string,
  propertyIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (propertyIds.length === 0) return out;
  const { data, error } = await db
    .from("ledger_entries")
    .select("property_id, due_date, amount_cents")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "charge")
    .eq("category_code", "rent_income")
    .in("property_id", propertyIds)
    .gte("due_date", from)
    .lte("due_date", to)
    .limit(5000);
  if (error) throw new Error("Could not load rent due.");
  for (const row of data ?? []) {
    const pid = String(row.property_id ?? "");
    const month = String(row.due_date ?? "").slice(0, 7);
    if (!pid || !/^\d{4}-\d{2}$/.test(month)) continue;
    const byMonth = out.get(pid) ?? {};
    byMonth[month] = (byMonth[month] ?? 0) + (Number(row.amount_cents) || 0);
    out.set(pid, byMonth);
  }
  return out;
}

/** Monthly rent per unit label, from the house's recurring rent profiles. Read by field; no resident field is touched. */
async function loadUnitRents(db: SupabaseClient, managerUserId: string, propertyId: string): Promise<Map<string, number>> {
  const { data } = await db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .limit(RENT_PROFILE_LIMIT);
  const out = new Map<string, number>();
  for (const row of data ?? []) {
    const profile = (row.row_data ?? {}) as { roomLabel?: unknown; monthlyRent?: unknown; active?: unknown };
    if (profile.active === false) continue;
    const label = humanizeUnitLabel(String(profile.roomLabel ?? "").trim());
    const rent = Number(profile.monthlyRent);
    if (label && Number.isFinite(rent) && rent > 0 && !out.has(label)) out.set(label, Math.round(rent * 100));
  }
  return out;
}

/**
 * The owner Overview / one-house summary.
 *
 * `grants` come from the authenticated membership (`loadOwnerGrants`); the
 * request contributes only `period` and an optional `propertyId`, and the
 * latter is refused unless it is already a house the owner may see.
 */
export async function loadOwnerSummary(
  db: SupabaseClient,
  grants: OwnerGrant[],
  input: { period: string | null; propertyId?: string | null },
): Promise<OwnerSummary> {
  const today = new Date().toISOString().slice(0, 7);
  const period = input.period == null || input.period === "" ? today : parseOwnerPeriod(input.period);
  if (!period) throw new OwnerScopeError("Choose a month like 2026-10.");

  let houses = grantedHouses(grants, "performance");
  const requested = (input.propertyId ?? "").trim();
  if (requested) {
    houses = houses.filter((h) => h.propertyId === requested);
    if (houses.length === 0) throw new OwnerScopeError();
  }

  const months = ownerMonthKeys(period, 12);
  const from = monthStart(months[0]!);
  const to = monthEnd(period);
  const inputs: OwnerHouseInputs[] = [];

  for (const [managerUserId, propertyIds] of groupByManager(houses)) {
    const [profit, due, display, occupancy] = await Promise.all([
      queryProfitability(db, managerUserId, { from, to, groupBy: "month", workspacePropertyIds: propertyIds }),
      loadRentDue(db, managerUserId, propertyIds, from, to),
      loadManagerReportDisplayContext(db, managerUserId),
      queryOccupancyReport(db, managerUserId, {
        scope: "portfolio",
        from: monthStart(period),
        to: monthEnd(period),
        workspacePropertyIds: propertyIds,
      }),
    ]);
    const profitRows: ProfitabilityMonthRow[] = profit.rows.map((r) => profitabilityRowFromCells(r));
    const occupancyById = new Map(occupancy.properties.map((p) => [p.propertyId, p]));

    for (const propertyId of propertyIds) {
      const occ = occupancyById.get(propertyId);
      let unitRows: OwnerUnitRow[] | undefined;
      if (requested && occ) {
        const rents = await loadUnitRents(db, managerUserId, propertyId);
        // `resident` is dropped here, field by field: only unit, status, rent and lease end go on.
        unitRows = occ.units.map((u) => ({
          unit: u.unit,
          status: u.status,
          rentCents: u.status === "occupied" ? (rents.get(u.unit) ?? null) : null,
          leaseEnd: u.status === "occupied" && /^\d{4}-\d{2}-\d{2}$/.test(u.leaseEnd) ? u.leaseEnd : null,
        }));
      } else if (requested) {
        unitRows = [];
      }
      inputs.push({
        propertyId,
        label: display.propertyLabel(propertyId),
        profitability: profitRows,
        rentDueByMonth: due.get(propertyId) ?? {},
        units: occ?.totalUnits ?? 0,
        occupied: occ?.occupiedUnits ?? 0,
        unitRows,
      });
    }
  }

  return buildOwnerSummary(period, inputs);
}

/** Month rows for the Statements list: cash collected less expenses paid, per month, over the houses the owner may see statements for. */
export async function loadOwnerStatements(
  db: SupabaseClient,
  grants: OwnerGrant[],
  input: { months?: number } = {},
): Promise<OwnerStatements> {
  const houses = grantedHouses(grants, "statements");
  if (houses.length === 0) return { rows: [] };
  const count = Math.min(24, Math.max(1, Math.floor(input.months ?? 12)));
  const keys = ownerMonthKeys(new Date().toISOString().slice(0, 7), count);
  const byManager = groupByManager(houses);
  const rows: OwnerStatementRow[] = [];
  for (const month of keys) {
    let cents = 0;
    for (const [managerUserId, propertyIds] of byManager) {
      const report = await queryOwnerStatement(db, managerUserId, {
        from: monthStart(month),
        to: monthEnd(month),
        workspacePropertyIds: propertyIds,
      });
      cents += dollarsToCents(String(report.meta?.distribution ?? "$0.00"));
    }
    rows.push({ month, houses: houses.length, distributionCents: cents });
  }
  return { rows: rows.reverse() };
}
