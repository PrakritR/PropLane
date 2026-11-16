import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { nextMonthKey, pacificMonthKey } from "@/lib/owner-management/fee-math";
import { listManagedWorkspacesForOwner } from "@/lib/owner-management/policies.server";
import { availableToWithdraw, ownerParty, readPartyBalance, readPartyLines, vendorParty } from "@/lib/managed-finance/ledger.server";
import { buildOwnerStatement, buildVendorStatement, type Statement, type StatementRow } from "@/lib/managed-finance/statement";
import { earningsByHouse, type HouseEarning } from "@/lib/managed-finance/earnings";
import { monthWindow, toStatementLines, withdrawalsFor, type FinanceBalance, type WithdrawalView } from "@/lib/managed-finance/finances.server";
import { activePayoutHold } from "@/lib/managed-finance/splits.server";
import { resolvePayoutDestination } from "@/lib/managed-finance/withdrawals.server";

/**
 * One person's Earnings across every PropLane-held balance they are owed: an owner's own workspaces, a team member's payout-split
 * shares, a vendor's bills. The person is the session; nothing in a request names whose balance this is.
 */

export type EarningsWorkspace = {
  workspaceId: string | null;
  workspaceName: string;
  role: "owner" | "team" | "vendor";
  balance: FinanceBalance;
};

export type UpcomingEarning = {
  id: string;
  availableOn: string;
  amountCents: number;
  workspaceId: string | null;
  workspaceName: string;
  label: string;
  propertyLabel: string | null;
};

export type EarningsMonth = {
  month: string;
  grossCents: number;
  feeCents: number;
  otherCents: number;
  vendorCents: number;
  netCents: number;
  withdrawnCents: number;
};

export type EarningsView = {
  totals: { balanceCents: number; availableCents: number; pendingCents: number };
  workspaces: EarningsWorkspace[];
  upcoming: UpcomingEarning[];
  paid: WithdrawalView[];
  months: EarningsMonth[];
  houses: Array<HouseEarning & { propertyLabel: string | null }>;
  payoutReady: boolean | null;
  /** Staff hold on this person's withdrawals (the reason stays with staff). */
  onHold: boolean;
};

const MONTH_COUNT = 12;
const MAX_UPCOMING = 100;

export function recentMonths(now: Date, count = MONTH_COUNT): string[] {
  const months: string[] = [];
  let key = pacificMonthKey(now);
  for (let i = 0; i < count; i += 1) {
    months.unshift(key);
    const [y, m] = key.split("-").map(Number);
    key = m === 1 ? `${(y ?? 0) - 1}-12` : `${y}-${String((m ?? 1) - 1).padStart(2, "0")}`;
  }
  return months;
}

type NamedLine = ReturnType<typeof toStatementLines>[number] & { workspaceId: string | null };

async function workspaceNames(db: SupabaseClient, ids: string[]): Promise<Map<string, { name: string; ownerUserId: string | null }>> {
  const out = new Map<string, { name: string; ownerUserId: string | null }>();
  if (ids.length === 0) return out;
  const { data } = await db.from("portal_workspaces").select("id, name, owner_user_id").in("id", ids);
  for (const r of (data ?? []) as Array<{ id: string; name: string | null; owner_user_id: string | null }>) {
    out.set(String(r.id), { name: r.name || "Workspace", ownerUserId: r.owner_user_id ? String(r.owner_user_id) : null });
  }
  return out;
}

/** The pure shape of a month row from a statement. */
export function monthRowFromStatement(month: string, s: Statement): EarningsMonth {
  return {
    month,
    grossCents: s.totals.rentGrossCents,
    feeCents: s.totals.feeCents,
    otherCents: s.totals.otherCents,
    vendorCents: s.totals.vendorChargesCents,
    netCents: s.totals.netCents,
    withdrawnCents: s.totals.withdrawalsCents,
  };
}

export async function loadMyEarnings(db: SupabaseClient, stripe: Stripe | null, userId: string, now: Date = new Date()): Promise<EarningsView> {
  const ownerKey = ownerParty(userId);
  const vendorKey = vendorParty(userId);
  const [ownerLines, vendorLines] = await Promise.all([
    readPartyLines(db, { account: "owner_payable", partyId: ownerKey }),
    readPartyLines(db, { account: "vendor_payable", partyId: vendorKey }),
  ]);
  const ownerSt = toStatementLines(ownerLines);
  const vendorSt = toStatementLines(vendorLines);

  const workspaceIds = [...new Set(ownerLines.map((l) => l.workspaceId).filter((v): v is string => Boolean(v)))];
  const names = await workspaceNames(db, workspaceIds);
  // The owner of record's reserve target holds part of their balance back, exactly as the withdrawal does.
  const owned = await listManagedWorkspacesForOwner(db, userId).catch(() => []);
  const reserveByWorkspace = new Map(owned.filter((w) => w.status === "active").map((w) => [w.workspaceId, w.terms.reserveTargetCents]));
  const policyWorkspaces = new Set(owned.map((w) => w.workspaceId));

  const workspaces: EarningsWorkspace[] = [];
  for (const id of workspaceIds) {
    const balance = await readPartyBalance(db, "owner_payable", ownerKey, id);
    const isOwner = policyWorkspaces.has(id);
    const reserve = reserveByWorkspace.get(id) ?? 0;
    workspaces.push({
      workspaceId: id,
      workspaceName: names.get(id)?.name ?? "Workspace",
      role: isOwner ? "owner" : "team",
      balance: { balanceCents: balance.owedCents, availableCents: availableToWithdraw(balance, reserve), pendingCents: balance.pendingCents, reserveCents: reserve },
    });
  }
  if (vendorLines.length > 0) {
    const balance = await readPartyBalance(db, "vendor_payable", vendorKey, null);
    workspaces.push({
      workspaceId: null, workspaceName: "Vendor work", role: "vendor",
      balance: { balanceCents: balance.owedCents, availableCents: availableToWithdraw(balance, 0), pendingCents: balance.pendingCents, reserveCents: 0 },
    });
  }

  const totals = workspaces.reduce(
    (t, w) => ({ balanceCents: t.balanceCents + w.balance.balanceCents, availableCents: t.availableCents + w.balance.availableCents, pendingCents: t.pendingCents + w.balance.pendingCents }),
    { balanceCents: 0, availableCents: 0, pendingCents: 0 },
  );

  // Upcoming: money earned that has not cleared yet (a credit whose availability date is still ahead).
  const nowMs = now.getTime();
  const upcomingLines: NamedLine[] = [...ownerLines, ...vendorLines]
    .filter((l) => l.amountCents < 0 && l.availableOn && Date.parse(l.availableOn) > nowMs)
    .map((l) => ({ ...toStatementLines([l])[0]!, workspaceId: l.workspaceId }));
  const display = new Map<string, Awaited<ReturnType<typeof loadManagerReportDisplayContext>> | null>();
  const labelFor = async (workspaceId: string | null, propertyId: string | null): Promise<string | null> => {
    if (!workspaceId || !propertyId) return null;
    const ownerId = names.get(workspaceId)?.ownerUserId;
    if (!ownerId) return null;
    if (!display.has(ownerId)) display.set(ownerId, await loadManagerReportDisplayContext(db, ownerId).catch(() => null));
    return display.get(ownerId)?.propertyLabel(propertyId) ?? null;
  };
  const upcoming: UpcomingEarning[] = [];
  for (const l of upcomingLines.sort((a, b) => String(a.availableOn).localeCompare(String(b.availableOn))).slice(0, MAX_UPCOMING)) {
    const propertyId = typeof l.detail.property_id === "string" ? l.detail.property_id : null;
    upcoming.push({
      id: `${l.journalId}:${l.workspaceId ?? "v"}`, availableOn: String(l.availableOn), amountCents: -l.amountCents, workspaceId: l.workspaceId,
      workspaceName: (l.workspaceId && names.get(l.workspaceId)?.name) || "Vendor work",
      label: l.kind === "split_allocation" ? "Your share of rent" : l.kind === "vendor_bill" ? "Service payment" : "Rent collected",
      propertyLabel: await labelFor(l.workspaceId, propertyId),
    });
  }

  const [ownerWd, vendorWd] = await Promise.all([withdrawalsFor(db, "owner", ownerKey, null), withdrawalsFor(db, "vendor", vendorKey, null)]);
  const paid = [...ownerWd, ...vendorWd].filter((w) => w.status === "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);

  const months = recentMonths(now).map((month) => {
    const { fromIso, toIso } = monthWindow(month);
    const o = monthRowFromStatement(month, buildOwnerStatement(ownerSt, fromIso, toIso));
    const v = monthRowFromStatement(month, buildVendorStatement(vendorSt, fromIso, toIso));
    return {
      month, grossCents: o.grossCents + v.grossCents, feeCents: o.feeCents + v.feeCents, otherCents: o.otherCents + v.otherCents,
      vendorCents: o.vendorCents + v.vendorCents, netCents: o.netCents + v.netCents, withdrawnCents: o.withdrawnCents + v.withdrawnCents,
    };
  });

  const byHouse = [...earningsByHouse(ownerSt), ...earningsByHouse(vendorSt)];
  const houses: EarningsView["houses"] = [];
  for (const h of byHouse) {
    // A label needs the workspace the house sits in; a house seen across several is labelled from the first workspace that knows it.
    let label: string | null = null;
    for (const id of workspaceIds) {
      label = await labelFor(id, h.propertyId);
      if (label) break;
    }
    houses.push({ ...h, propertyLabel: label });
  }

  let payoutReady: boolean | null = null;
  if (stripe) {
    const dest = await resolvePayoutDestination(stripe, db, userId).catch(() => null);
    payoutReady = dest ? !("error" in dest) : null;
  }
  const hold = await activePayoutHold(db, ownerKey, null).catch(() => null);
  const vendorHold = hold ? null : await activePayoutHold(db, vendorKey, null).catch(() => null);
  return { totals, workspaces, upcoming, paid, months, houses, payoutReady, onHold: Boolean(hold || vendorHold) };
}

/** The earnings report rows for the CSV: every statement row of every month in the window, with its workspace. */
export async function loadMyEarningsRows(db: SupabaseClient, userId: string, month: string | null, now: Date = new Date()): Promise<Array<StatementRow & { workspaceName: string; propertyLabel: string | null }>> {
  const [ownerLines, vendorLines] = await Promise.all([
    readPartyLines(db, { account: "owner_payable", partyId: ownerParty(userId) }),
    readPartyLines(db, { account: "vendor_payable", partyId: vendorParty(userId) }),
  ]);
  const keys = month ? [month] : recentMonths(now);
  const first = monthWindow(keys[0]!).fromIso;
  const last = monthWindow(nextMonthKey(keys[keys.length - 1]!)).fromIso;
  const ownerStatement = buildOwnerStatement(toStatementLines(ownerLines), first, last);
  const vendorStatement = buildVendorStatement(toStatementLines(vendorLines), first, last);
  const workspaceByJournal = new Map(ownerLines.map((l) => [l.journalId, l.workspaceId]));
  const names = await workspaceNames(db, [...new Set([...workspaceByJournal.values()].filter((v): v is string => Boolean(v)))]);
  const rows = [...ownerStatement.rows, ...vendorStatement.rows].sort((a, b) => a.date.localeCompare(b.date));
  return rows.map((r) => {
    const ws = workspaceByJournal.get(r.id.split(":")[0]!) ?? null;
    return { ...r, workspaceName: (ws && names.get(ws)?.name) || "", propertyLabel: null };
  });
}
