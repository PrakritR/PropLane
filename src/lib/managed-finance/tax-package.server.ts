import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { LedgerError, ownerParty, readPartyLines } from "@/lib/managed-finance/ledger.server";
import { pacificMonthStartIso } from "@/lib/owner-management/fee-math";
import { listPoliciesForWorkspace, PolicyError } from "@/lib/owner-management/policies.server";
import { buildTaxPackage, taxPackageCsv, type TaxPackage } from "@/lib/managed-finance/tax-package";
import type { StatementLine } from "@/lib/managed-finance/statement";

export type OwnerTaxView = { package: TaxPackage; houseLabels: Record<string, string>; csv: string };

const VENDOR_LINE_PAGE_SIZE = 1000;
const VENDOR_LINE_MAX_PAGES = 1000;

/** The owner of record's year-end package for one managed workspace. The workspace is proven by the policy lookup. */
export async function loadOwnerTaxPackage(db: SupabaseClient, input: { ownerUserId: string; workspaceId: string; year: number }): Promise<OwnerTaxView> {
  if (!Number.isSafeInteger(input.year) || input.year < 2020 || input.year > 2100) throw new LedgerError(400, "Choose a year.");
  const mine = (await listPoliciesForWorkspace(db, input.workspaceId)).filter((p) => p.ownerUserId === input.ownerUserId && p.signedAt);
  if (mine.length === 0) throw new PolicyError(404, "Not found.");
  const fromIso = pacificMonthStartIso(`${input.year}-01`);
  const toIso = pacificMonthStartIso(`${input.year + 1}-01`);
  const ownerRows = await readPartyLines(db, { account: "owner_payable", partyId: ownerParty(input.ownerUserId), workspaceId: input.workspaceId, fromIso, toIso });
  const toLine = (l: (typeof ownerRows)[number]): StatementLine => ({
    journalId: l.journalId, amountCents: l.amountCents, availableOn: l.availableOn, postedAt: l.postedAt, kind: l.kind, detail: l.detail,
    sourceType: l.sourceType, sourceId: l.sourceId,
  });
  // The vendors paid on this workspace's behalf: the vendor side of each of its vendor-bill journals in the year.
  // Windowed and paged in SQL: an arbitrary 5000-row cap understated a 1099 total, which can flip a vendor
  // across the reportable threshold.
  const vendorRaw: Array<Record<string, unknown>> = [];
  for (let page = 0; page < VENDOR_LINE_MAX_PAGES; page += 1) {
    const { data, error } = await db
      .from("party_ledger_lines")
      .select("party_id, amount_cents, journal_id, created_at, party_ledger_journals!inner(kind, posted_at, detail, source_type, source_id)")
      .eq("account", "vendor_payable")
      .eq("workspace_id", input.workspaceId)
      .gte("party_ledger_journals.posted_at", fromIso)
      .lt("party_ledger_journals.posted_at", toIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * VENDOR_LINE_PAGE_SIZE, page * VENDOR_LINE_PAGE_SIZE + VENDOR_LINE_PAGE_SIZE - 1);
    if (error) throw new LedgerError(500, "Could not read vendor payments.");
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    vendorRaw.push(...batch);
    if (batch.length < VENDOR_LINE_PAGE_SIZE) break;
  }
  const vendorLines = vendorRaw.map((r) => {
    const j = (Array.isArray(r.party_ledger_journals) ? r.party_ledger_journals[0] : r.party_ledger_journals) as Record<string, unknown>;
    return {
      partyId: String(r.party_id), journalId: String(r.journal_id), amountCents: Number(r.amount_cents), availableOn: null,
      postedAt: String(j?.posted_at ?? ""), kind: String(j?.kind ?? ""), detail: (j?.detail as Record<string, unknown>) ?? {},
      sourceType: (j?.source_type as string | null) ?? null, sourceId: (j?.source_id as string | null) ?? null,
    };
  });
  const vendorUserIds = [...new Set(vendorLines.map((l) => l.partyId).filter((p) => p.startsWith("vendor:")).map((p) => p.slice(7)))];
  const { data: profiles } = vendorUserIds.length ? await db.from("profiles").select("id, full_name, email").in("id", vendorUserIds) : { data: [] };
  const names = new Map<string, string>(((profiles ?? []) as Array<{ id: string; full_name?: string; email?: string }>).map((p) => [`vendor:${p.id}`, String(p.full_name || p.email || "Vendor")]));

  const pkg = buildTaxPackage(
    input.year,
    ownerRows.map(toLine),
    vendorLines as Array<StatementLine & { partyId: string }>,
    names,
    "",
    { fromIso, toIso },
  );
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", input.workspaceId).maybeSingle();
  const display = (ws as { owner_user_id?: string } | null)?.owner_user_id
    ? await loadManagerReportDisplayContext(db, (ws as { owner_user_id: string }).owner_user_id).catch(() => null) : null;
  const houseLabels: Record<string, string> = {};
  for (const h of pkg.houses) if (h.propertyId) houseLabels[h.propertyId] = display?.propertyLabel(h.propertyId) ?? h.propertyId;
  return { package: pkg, houseLabels, csv: taxPackageCsv(pkg, new Map(Object.entries(houseLabels))) };
}
