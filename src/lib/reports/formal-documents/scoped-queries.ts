import type { SupabaseClient } from "@supabase/supabase-js";
import { humanizeUnitLabel, loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import type { RecurringRentProfile } from "@/lib/household-charges";
import { chartAccountLabel } from "@/lib/reports/categories";
import { primeSystemChartOfAccounts, systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import {
  receiptNumberForLedgerEntry,
  scopeLabel,
  type DaysRentedDocument,
  type IncomeCategoryRow,
  type PropertyRentReceiptDocument,
  type PropertyRentReceiptUnitRow,
  type RentReceiptDocument,
} from "@/lib/reports/formal-documents/spec";
import { centsToUsd } from "@/lib/reports/money";
import type { DocumentScope, FormalDocumentFilters, ManagerReportFilters, ReportResult } from "@/lib/reports/types";
import { applyReportPropertyScope } from "@/lib/reports/workspace-scope";

const RENT_RECEIPT_CATEGORIES = new Set(["rent_income", "late_fees", "pet_rent", "application_fee", "other_income"]);

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate = from?.trim() || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

function daysInclusive(from: Date, to: Date): number {
  if (to < from) return 0;
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function resolveScope(filters: FormalDocumentFilters): DocumentScope {
  if (filters.scope) return filters.scope;
  if (filters.roomLabel?.trim()) return "room";
  if (filters.residentEmail?.trim()) return "tenant";
  if (filters.propertyId?.trim()) return "property";
  return "portfolio";
}

async function loadManagerTaxProfile(db: SupabaseClient, managerUserId: string) {
  const { data } = await db
    .from("manager_tax_profiles")
    .select("legal_name, address_line1, address_line2, city, state, zip")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const name = data?.legal_name?.trim() || "Property manager";
  const parts = [
    data?.address_line1?.trim(),
    data?.address_line2?.trim(),
    [data?.city, data?.state, data?.zip].filter(Boolean).join(", ").trim(),
  ].filter(Boolean);
  return { name, address: parts.join("\n") || "—" };
}

async function loadRentProfiles(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
  propertyId?: string,
) {
  let query = db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .limit(500);
  query = applyReportPropertyScope(query, filters, propertyId);
  const { data } = await query;
  return (data ?? []).map((r) => r.row_data as RecurringRentProfile).filter(Boolean);
}

function profileMatchesScope(
  p: RecurringRentProfile,
  scope: DocumentScope,
  filters: FormalDocumentFilters,
): boolean {
  if (scope === "portfolio") return true;
  if (scope === "property" && filters.propertyId && p.propertyId !== filters.propertyId) return false;
  if (scope === "tenant" && filters.residentEmail) {
    if (p.residentEmail?.toLowerCase() !== filters.residentEmail.toLowerCase()) return false;
  }
  if (scope === "room" && filters.roomLabel) {
    const unit = (p.roomLabel || "").trim().toLowerCase();
    if (unit !== filters.roomLabel.trim().toLowerCase()) return false;
  }
  return true;
}

function daysRentedForProfile(
  p: RecurringRentProfile,
  rangeStart: Date,
  rangeEnd: Date,
): { daysRented: number; daysAvailable: number } {
  const daysAvailable = daysInclusive(rangeStart, rangeEnd);
  const leaseStart = p.startMonth?.trim()
    ? new Date(`${p.startMonth.trim()}-01T12:00:00`)
    : rangeStart;
  const leaseEnd = p.leaseEnd?.trim() ? new Date(`${p.leaseEnd.trim()}T12:00:00`) : rangeEnd;
  const overlapStart = leaseStart > rangeStart ? leaseStart : rangeStart;
  const overlapEnd = leaseEnd < rangeEnd ? leaseEnd : rangeEnd;
  return { daysRented: daysInclusive(overlapStart, overlapEnd), daysAvailable };
}

function profileUnitKey(p: RecurringRentProfile): string {
  return `${p.propertyId ?? ""}|${(p.roomLabel || "").trim().toLowerCase()}|${(p.residentEmail || "").trim().toLowerCase()}`;
}

export async function queryFormalPropertyRentReceipts(
  db: SupabaseClient,
  managerUserId: string,
  filters: FormalDocumentFilters,
): Promise<{ documents: PropertyRentReceiptDocument[]; preview: ReportResult }> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const scope = resolveScope(filters);
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const [landlord, display, profiles] = await Promise.all([
    loadManagerTaxProfile(db, managerUserId),
    loadManagerReportDisplayContext(db, managerUserId),
    loadRentProfiles(db, managerUserId, filters, scope === "property" ? filters.propertyId : undefined).then((rows) =>
      rows.filter((p) => p.active !== false).filter((p) => profileMatchesScope(p, scope, filters)),
    ),
  ]);

  let ledgerQuery = db
    .from("ledger_entries")
    .select("id, posted_date, amount_cents, category_code, property_id, resident_email, unit_label")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to);
  ledgerQuery = applyReportPropertyScope(ledgerQuery, filters, scope === "property" ? filters.propertyId : undefined);
  if (scope === "tenant" && filters.residentEmail) {
    ledgerQuery = ledgerQuery.eq("resident_email", filters.residentEmail.trim());
  }
  if (scope === "room" && filters.roomLabel) {
    ledgerQuery = ledgerQuery.eq("unit_label", filters.roomLabel.trim());
  }
  const { data: ledgerRows } = await ledgerQuery;

  const propertyLabels = new Map<string, string>();
  const unitsByProperty = new Map<string, Map<string, PropertyRentReceiptUnitRow>>();
  const incomeByCategoryMap = new Map<string, Map<string, number>>(); // propertyId → categoryCode → amountCents

  for (const p of profiles) {
    const propertyId = p.propertyId?.trim() || "unassigned";
    const propertyLabel = p.propertyLabel?.trim() || display.propertyLabel(propertyId);
    propertyLabels.set(propertyId, propertyLabel);
    const { daysRented, daysAvailable } = daysRentedForProfile(p, rangeStart, rangeEnd);
    if (daysRented <= 0) continue;

    const unitKey = profileUnitKey(p);
    if (!unitsByProperty.has(propertyId)) unitsByProperty.set(propertyId, new Map());
    const unitMap = unitsByProperty.get(propertyId)!;
    unitMap.set(unitKey, {
      unit: humanizeUnitLabel(p.roomLabel?.trim() || "") || "—",
      resident: p.residentName?.trim() || display.residentLabel(p.residentEmail) || "—",
      daysRented,
      daysAvailable,
      rentCollected: "$0.00",
      receiptCount: 0,
    });
  }

  for (const row of ledgerRows ?? []) {
    if (!RENT_RECEIPT_CATEGORIES.has(String(row.category_code))) continue;
    const propertyId = String(row.property_id ?? "unassigned").trim() || "unassigned";
    const email = String(row.resident_email ?? "").toLowerCase();
    const unitLabel = String(row.unit_label ?? "").trim();
    const profile =
      profiles.find(
        (p) =>
          (p.propertyId?.trim() || "unassigned") === propertyId &&
          (p.residentEmail?.toLowerCase() ?? "") === email &&
          (unitLabel ? (p.roomLabel || "").trim().toLowerCase() === unitLabel.toLowerCase() : true),
      ) ?? profiles.find((p) => (p.propertyId?.trim() || "unassigned") === propertyId && p.residentEmail?.toLowerCase() === email);

    if (profile) {
      propertyLabels.set(propertyId, profile.propertyLabel?.trim() || display.propertyLabel(propertyId));
    }

    const unitKey = profile
      ? profileUnitKey(profile)
      : `${propertyId}|${unitLabel.toLowerCase()}|${email}`;
    if (!unitsByProperty.has(propertyId)) unitsByProperty.set(propertyId, new Map());
    const unitMap = unitsByProperty.get(propertyId)!;

    if (!unitMap.has(unitKey)) {
      const days = profile
        ? daysRentedForProfile(profile, rangeStart, rangeEnd)
        : { daysRented: 0, daysAvailable: daysInclusive(rangeStart, rangeEnd) };
      unitMap.set(unitKey, {
        unit: humanizeUnitLabel(unitLabel || profile?.roomLabel?.trim() || "") || "—",
        resident: profile?.residentName?.trim() || display.residentLabel(email) || "—",
        daysRented: days.daysRented,
        daysAvailable: days.daysAvailable,
        rentCollected: "$0.00",
        receiptCount: 0,
      });
    }

    const unit = unitMap.get(unitKey)!;
    const amountCents = Number(row.amount_cents);
    const prevCents = Math.round(Number.parseFloat(unit.rentCollected.replace(/[^0-9.]/g, "")) * 100) || 0;
    unit.rentCollected = centsToUsd(prevCents + amountCents);
    unit.receiptCount += 1;

    // Track income by category for Schedule E breakdown
    if (!incomeByCategoryMap.has(propertyId)) incomeByCategoryMap.set(propertyId, new Map());
    const catMap = incomeByCategoryMap.get(propertyId)!;
    const categoryCode = String(row.category_code ?? "other_income");
    catMap.set(categoryCode, (catMap.get(categoryCode) ?? 0) + amountCents);
  }

  const INCOME_CATEGORY_ORDER = ["rent_income", "late_fees", "pet_rent", "application_fee", "other_income"];

  const issueDate = new Date().toISOString().slice(0, 10);
  const documents: PropertyRentReceiptDocument[] = [];

  for (const [propertyId, unitMap] of unitsByProperty.entries()) {
    const units = [...unitMap.values()].sort((a, b) => a.unit.localeCompare(b.unit));
    const daysRented = units.reduce((sum, u) => sum + u.daysRented, 0);
    const daysAvailable = units.reduce((sum, u) => sum + u.daysAvailable, 0);
    const rentCents = units.reduce(
      (sum, u) => sum + Math.round(Number.parseFloat(u.rentCollected.replace(/[^0-9.]/g, "")) * 100),
      0,
    );
    const receiptCount = units.reduce((sum, u) => sum + u.receiptCount, 0);
    const propertyLabel = propertyLabels.get(propertyId) ?? display.propertyLabel(propertyId);

    const catMap = incomeByCategoryMap.get(propertyId);
    const incomeByCategory: IncomeCategoryRow[] = catMap
      ? [...catMap.entries()]
          .map(([code, cents]) => {
            const acct = systemChartAccountByCode(code);
            return {
              categoryCode: code,
              label: acct?.name ?? chartAccountLabel(code),
              scheduleERef: acct?.scheduleERef ?? "Sch. E, Line 3",
              amountCents: cents,
              amount: centsToUsd(cents),
            };
          })
          .sort(
            (a, b) =>
              (INCOME_CATEGORY_ORDER.indexOf(a.categoryCode) === -1 ? 99 : INCOME_CATEGORY_ORDER.indexOf(a.categoryCode)) -
              (INCOME_CATEGORY_ORDER.indexOf(b.categoryCode) === -1 ? 99 : INCOME_CATEGORY_ORDER.indexOf(b.categoryCode)),
          )
      : [];

    documents.push({
      id: `property-${propertyId}-${from}-${to}`,
      propertyId,
      propertyLabel,
      issueDate,
      periodFrom: from,
      periodTo: to,
      landlordName: landlord.name,
      landlordAddress: landlord.address,
      daysRented,
      daysAvailable,
      rentCollected: centsToUsd(rentCents),
      receiptCount,
      rentalUsePct: daysAvailable > 0 ? Math.round((daysRented / daysAvailable) * 1000) / 10 : 0,
      units,
      incomeByCategory,
      grossIncomeCents: rentCents,
    });
  }

  documents.sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel));

  const preview: ReportResult = {
    id: "property-rent-receipts",
    title: "Rent receipts by property",
    columns: [
      { key: "property", label: "Property" },
      { key: "daysRented", label: "Days rented", align: "right", format: "number" },
      { key: "daysAvailable", label: "Days available", align: "right", format: "number" },
      { key: "rentCollected", label: "Rent collected", align: "right", format: "money" },
      { key: "receiptCount", label: "Receipts", align: "right", format: "number" },
      { key: "rentalUsePct", label: "Rental use %", align: "right", format: "number" },
    ],
    rows: documents.map((d) => ({
      property: d.propertyLabel,
      daysRented: d.daysRented,
      daysAvailable: d.daysAvailable,
      rentCollected: d.rentCollected,
      receiptCount: d.receiptCount,
      rentalUsePct: d.rentalUsePct,
    })),
    totals: {
      property: `${documents.length} propert${documents.length === 1 ? "y" : "ies"}`,
      daysRented: documents.reduce((s, d) => s + d.daysRented, 0),
      daysAvailable: documents.reduce((s, d) => s + d.daysAvailable, 0),
      rentCollected: centsToUsd(
        documents.reduce(
          (s, d) => s + Math.round(Number.parseFloat(d.rentCollected.replace(/[^0-9.]/g, "")) * 100),
          0,
        ),
      ),
      receiptCount: documents.reduce((s, d) => s + d.receiptCount, 0),
      rentalUsePct: "",
    },
    meta: {
      from,
      to,
      scope,
      scopeLabel: scopeLabel(
        scope,
        filters.propertyId ? display.propertyLabel(filters.propertyId) : undefined,
        filters.residentEmail ? display.residentLabel(filters.residentEmail) : undefined,
        filters.roomLabel,
      ),
    },
  };

  return { documents, preview };
}

export async function queryFormalRentReceipts(
  db: SupabaseClient,
  managerUserId: string,
  filters: FormalDocumentFilters,
): Promise<{ documents: RentReceiptDocument[]; preview: ReportResult }> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const scope = resolveScope(filters);
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const [landlord, display, profiles] = await Promise.all([
    loadManagerTaxProfile(db, managerUserId),
    loadManagerReportDisplayContext(db, managerUserId),
    loadRentProfiles(db, managerUserId, filters, scope === "property" ? filters.propertyId : undefined),
  ]);
  const profileByEmail = new Map(profiles.map((p) => [p.residentEmail?.toLowerCase(), p]));

  let query = db
    .from("ledger_entries")
    .select("id, posted_date, description, amount_cents, category_code, property_id, resident_email, unit_label, stripe_checkout_session_id")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to)
    .order("posted_date", { ascending: false });

  query = applyReportPropertyScope(query, filters, scope === "property" ? filters.propertyId : undefined);
  if (scope === "tenant" && filters.residentEmail) {
    query = query.eq("resident_email", filters.residentEmail.trim());
  }
  if (scope === "room" && filters.roomLabel) {
    query = query.eq("unit_label", filters.roomLabel.trim());
  }

  const { data } = await query;
  const issueDate = new Date().toISOString().slice(0, 10);
  const documents: RentReceiptDocument[] = [];

  for (const row of data ?? []) {
    if (!RENT_RECEIPT_CATEGORIES.has(String(row.category_code))) continue;
    const email = String(row.resident_email ?? "").toLowerCase();
    const profile = profileByEmail.get(email);
    const occupancy = profile ? daysRentedForProfile(profile, rangeStart, rangeEnd) : { daysRented: 0, daysAvailable: 0 };
    const ledgerId = String(row.id);
    documents.push({
      id: ledgerId,
      receiptNumber: receiptNumberForLedgerEntry(ledgerId),
      issueDate,
      landlordName: landlord.name,
      landlordAddress: landlord.address,
      tenantName: profile?.residentName?.trim() || display.residentLabel(email) || "Resident",
      tenantEmail: row.resident_email ?? "",
      propertyLabel: profile?.propertyLabel?.trim() || display.propertyLabel(String(row.property_id ?? "")),
      unitLabel: humanizeUnitLabel(String(row.unit_label || profile?.roomLabel || "").trim()) || "—",
      propertyAddress: profile?.propertyLabel || "—",
      paymentDate: String(row.posted_date),
      amount: centsToUsd(Number(row.amount_cents)),
      paymentMethod: row.stripe_checkout_session_id ? "Online (Stripe)" : "Manual",
      periodCovered: row.description?.trim() || chartAccountLabel(String(row.category_code)),
      category: chartAccountLabel(String(row.category_code)),
      daysRented: occupancy.daysRented,
      daysAvailable: occupancy.daysAvailable,
    });
  }

  const preview: ReportResult = {
    id: "rent-receipts",
    title: "Rent receipts",
    columns: [
      { key: "receiptNumber", label: "Receipt #" },
      { key: "paymentDate", label: "Date", format: "date" },
      { key: "tenantName", label: "Resident" },
      { key: "propertyLabel", label: "Property" },
      { key: "unitLabel", label: "Unit" },
      { key: "daysRented", label: "Days rented", align: "right", format: "number" },
      { key: "daysAvailable", label: "Days available", align: "right", format: "number" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "category", label: "Type" },
    ],
    rows: documents.map((d) => ({
      receiptNumber: d.receiptNumber,
      paymentDate: d.paymentDate,
      tenantName: d.tenantName,
      propertyLabel: d.propertyLabel,
      unitLabel: d.unitLabel,
      daysRented: d.daysRented ?? 0,
      daysAvailable: d.daysAvailable ?? 0,
      amount: d.amount,
      category: d.category,
    })),
    totals: {
      receiptNumber: `${documents.length} receipt(s)`,
      paymentDate: "",
      tenantName: "",
      propertyLabel: "",
      unitLabel: "",
      amount: centsToUsd(documents.reduce((s, d) => s + Math.round(Number.parseFloat(d.amount.replace(/[^0-9.]/g, "")) * 100), 0)),
      category: "",
    },
    meta: {
      from,
      to,
      scope,
      scopeLabel: scopeLabel(
        scope,
        filters.propertyId ? display.propertyLabel(filters.propertyId) : undefined,
        filters.residentEmail ? display.residentLabel(filters.residentEmail) : undefined,
        filters.roomLabel,
      ),
    },
  };

  return { documents, preview };
}

export async function queryFormalDaysRented(
  db: SupabaseClient,
  managerUserId: string,
  filters: FormalDocumentFilters,
): Promise<{ document: DaysRentedDocument; preview: ReportResult }> {
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const scope = resolveScope(filters);
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const daysAvailableInPeriod = daysInclusive(rangeStart, rangeEnd);
  const landlord = await loadManagerTaxProfile(db, managerUserId);
  const profiles = await loadRentProfiles(db, managerUserId, filters, scope === "property" ? filters.propertyId : undefined);

  const rows = profiles
    .filter((p) => p.active !== false)
    .filter((p) => profileMatchesScope(p, scope, filters))
    .map((p) => {
      const { daysRented, daysAvailable } = daysRentedForProfile(p, rangeStart, rangeEnd);
      const leaseStart = p.startMonth?.trim()
        ? new Date(`${p.startMonth.trim()}-01T12:00:00`)
        : rangeStart;
      return {
        property: p.propertyLabel,
        unit: humanizeUnitLabel(p.roomLabel?.trim() || "") || "—",
        resident: p.residentName,
        residentEmail: p.residentEmail,
        leaseStart: leaseStart.toISOString().slice(0, 10),
        leaseEnd: p.leaseEnd?.trim() || "—",
        daysRented,
        daysAvailable,
      };
    })
    .filter((row) => row.daysRented > 0)
    .sort((a, b) => String(a.property).localeCompare(String(b.property)));

  const totalDaysRented = rows.reduce((sum, row) => sum + row.daysRented, 0);
  const label = scopeLabel(
    scope,
    profiles.find((p) => p.propertyId === filters.propertyId)?.propertyLabel,
    profiles.find((p) => p.residentEmail?.toLowerCase() === filters.residentEmail?.toLowerCase())?.residentName,
    filters.roomLabel,
  );

  const document: DaysRentedDocument = {
    id: `days-${scope}-${from}-${to}`,
    issueDate: new Date().toISOString().slice(0, 10),
    scopeLabel: label,
    periodFrom: from,
    periodTo: to,
    landlordName: landlord.name,
    landlordAddress: landlord.address,
    rows,
    totalDaysRented,
    totalDaysAvailable: daysAvailableInPeriod * Math.max(rows.length, 1),
    unitCount: rows.length,
  };

  const preview: ReportResult = {
    id: "rental-days",
    title: "Days rented",
    columns: [
      { key: "property", label: "Property" },
      { key: "unit", label: "Unit" },
      { key: "resident", label: "Resident" },
      { key: "leaseStart", label: "Lease start", format: "date" },
      { key: "leaseEnd", label: "Lease end", format: "date" },
      { key: "daysRented", label: "Days rented", align: "right", format: "number" },
      { key: "daysAvailable", label: "Days available", align: "right", format: "number" },
    ],
    rows,
    totals: {
      property: label,
      unit: `${rows.length} unit(s)`,
      resident: "",
      leaseStart: "",
      leaseEnd: "",
      daysRented: totalDaysRented,
      daysAvailable: document.totalDaysAvailable,
    },
    meta: { from, to, scope, scopeLabel: label, totalDaysRented },
  };

  return { document, preview };
}

export async function loadFormalDocumentScopeOptions(
  db: SupabaseClient,
  managerUserId: string,
  propertyId?: string,
  workspacePropertyIds: string[] | null = null,
) {
  const [profiles, display] = await Promise.all([
    loadRentProfiles(db, managerUserId, { workspacePropertyIds }, propertyId),
    loadManagerReportDisplayContext(db, managerUserId),
  ]);
  const tenants = new Map<string, string>();
  const rooms = new Set<string>();
  const properties = new Map<string, string>();

  for (const p of profiles) {
    if (p.propertyId) properties.set(p.propertyId, p.propertyLabel || display.propertyLabel(p.propertyId));
    if (p.residentEmail) tenants.set(p.residentEmail.toLowerCase(), p.residentName || p.residentEmail);
    if (p.roomLabel?.trim()) rooms.add(p.roomLabel.trim());
  }

  return {
    properties: [...properties.entries()].map(([id, label]) => ({ id, label })),
    tenants: [...tenants.entries()].map(([email, name]) => ({ email, name })),
    rooms: [...rooms]
      .sort((a, b) => humanizeUnitLabel(a).localeCompare(humanizeUnitLabel(b), undefined, { numeric: true }))
      .map((id) => {
        const unit = humanizeUnitLabel(id);
        if (propertyId?.trim() || !id.includes("::")) {
          return { id, label: unit };
        }
        const propId = id.split("::")[0]?.trim() ?? "";
        const propLabel = properties.get(propId) ?? display.propertyLabel(propId);
        return { id, label: `${propLabel} · ${unit}` };
      }),
  };
}

export async function queryOccupancyReport(
  db: SupabaseClient,
  managerUserId: string,
  filters: FormalDocumentFilters,
): Promise<import("./spec").OccupancyReport> {
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const scope = resolveScope(filters);
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const [landlord, display, allProfiles] = await Promise.all([
    loadManagerTaxProfile(db, managerUserId),
    loadManagerReportDisplayContext(db, managerUserId),
    loadRentProfiles(db, managerUserId, filters, scope === "property" ? filters.propertyId : undefined),
  ]);
  const profiles = allProfiles.filter((p) => profileMatchesScope(p, scope, filters));

  const propertyGroups = new Map<string, { label: string; units: import("./spec").OccupancyUnitRow[] }>();

  for (const p of profiles) {
    const propertyId = p.propertyId?.trim() || "unassigned";
    const propertyLabel = p.propertyLabel?.trim() || display.propertyLabel(propertyId);
    const { daysRented, daysAvailable } = daysRentedForProfile(p, rangeStart, rangeEnd);
    const leaseStartRaw = p.startMonth?.trim() ? `${p.startMonth.trim()}-01` : from;
    const occupancyPct = daysAvailable > 0 ? Math.round((daysRented / daysAvailable) * 1000) / 10 : 0;

    if (!propertyGroups.has(propertyId)) propertyGroups.set(propertyId, { label: propertyLabel, units: [] });
    propertyGroups.get(propertyId)!.units.push({
      unit: humanizeUnitLabel(p.roomLabel?.trim() || "") || "—",
      resident: p.residentName?.trim() || "—",
      leaseStart: leaseStartRaw,
      leaseEnd: p.leaseEnd?.trim() || "—",
      daysRented,
      daysAvailable,
      occupancyPct,
      status: daysRented > 0 ? "occupied" : "vacant",
    });
  }

  const propertyList: import("./spec").OccupancyPropertyGroup[] = [];
  for (const [propertyId, group] of propertyGroups) {
    const units = group.units.sort((a, b) => a.unit.localeCompare(b.unit));
    const totalDaysRented = units.reduce((s, u) => s + u.daysRented, 0);
    const totalDaysAvailable = units.reduce((s, u) => s + u.daysAvailable, 0);
    const occupiedUnits = units.filter((u) => u.status === "occupied").length;
    propertyList.push({
      propertyId,
      propertyLabel: group.label,
      totalUnits: units.length,
      occupiedUnits,
      vacantUnits: units.length - occupiedUnits,
      daysRented: totalDaysRented,
      daysAvailable: totalDaysAvailable,
      occupancyPct: totalDaysAvailable > 0 ? Math.round((totalDaysRented / totalDaysAvailable) * 1000) / 10 : 0,
      units,
    });
  }

  propertyList.sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel));

  const totalUnits = propertyList.reduce((s, p) => s + p.totalUnits, 0);
  const occupiedUnits = propertyList.reduce((s, p) => s + p.occupiedUnits, 0);
  const totalDaysRented = propertyList.reduce((s, p) => s + p.daysRented, 0);
  const totalDaysAvailable = propertyList.reduce((s, p) => s + p.daysAvailable, 0);

  return {
    id: `occupancy-${from}-${to}`,
    issueDate: new Date().toISOString().slice(0, 10),
    periodFrom: from,
    periodTo: to,
    landlordName: landlord.name,
    landlordAddress: landlord.address,
    properties: propertyList,
    portfolioOccupancyPct: totalDaysAvailable > 0 ? Math.round((totalDaysRented / totalDaysAvailable) * 1000) / 10 : 0,
    totalUnits,
    occupiedUnits,
  };
}

export function applyFormalDocumentScope(
  filters: Partial<FormalDocumentFilters> & ManagerReportFilters,
): FormalDocumentFilters {
  const scope = resolveScope(filters as FormalDocumentFilters);
  return { ...filters, scope } as FormalDocumentFilters;
}
