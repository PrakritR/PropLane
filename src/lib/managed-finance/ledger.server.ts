import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";

/**
 * The party ledger (docs/agents/owner-management.md § Ledger). Append-only, balanced journals; every poster is idempotent on its
 * key. Signed cents: debit positive, credit negative; what a party is owed is the negative of the sum of their payable lines.
 */

export type LedgerAccount =
  | "platform_cash"
  | "owner_payable"
  | "vendor_payable"
  | "proplane_fee_revenue"
  | "processing_recovery"
  | "tenant_deposit_liability"
  | "withdrawal_in_flight"
  | "dispute_hold"
  | "platform_dispute_expense";

export type LedgerLine = {
  account: LedgerAccount;
  party_id?: string | null;
  workspace_id?: string | null;
  amount_cents: number;
  available_on?: string | null;
};

export class LedgerError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export const ownerParty = (userId: string): string => `owner:${userId}`;
export const vendorParty = (userId: string): string => `vendor:${userId}`;
export const vendorDirectoryParty = (directoryId: string): string => `vendor_dir:${directoryId}`;

export type Balance = { owedCents: number; maturedCents: number; pendingCents: number };

/** Owed / matured / pending for one payable account, from the ledger. */
export async function readPartyBalance(
  db: SupabaseClient,
  account: "owner_payable" | "vendor_payable",
  partyId: string,
  workspaceId: string | null,
): Promise<Balance> {
  const { data, error } = await db.rpc("party_balance", { p_account: account, p_party: partyId, p_workspace: workspaceId });
  const row = (Array.isArray(data) ? data[0] : data) as { owed?: number | string; matured?: number | string; pending?: number | string } | null;
  if (error) {
    if (isMissingSchemaError(error)) return { owedCents: 0, maturedCents: 0, pendingCents: 0 };
    throw new LedgerError(500, "Could not read the balance.");
  }
  return { owedCents: Number(row?.owed ?? 0), maturedCents: Number(row?.matured ?? 0), pendingCents: Number(row?.pending ?? 0) };
}

/** What can be withdrawn right now: matured credits less debits, never more than owed, less the reserve target. */
export function availableToWithdraw(balance: Balance, reserveCents: number): number {
  return Math.max(0, Math.min(balance.owedCents, balance.maturedCents) - Math.max(0, reserveCents));
}

export type PostJournalInput = {
  workspaceId: string | null;
  kind:
    | "rent_capture" | "refund" | "dispute_opened" | "dispute_won" | "dispute_lost" | "vendor_bill" | "vendor_bill_reversal"
    | "withdrawal_reserve" | "withdrawal_complete" | "withdrawal_failed" | "adjustment" | "directory_claim";
  key: string;
  sourceType?: string | null;
  sourceId?: string | null;
  stripeObjectId?: string | null;
  detail?: Record<string, unknown>;
  lines: LedgerLine[];
  postedAt?: string | null;
};

/** Post one balanced journal. Returns whether it was newly created. A replay with different lines throws. */
export async function postJournal(db: SupabaseClient, input: PostJournalInput): Promise<{ created: boolean; journalId: string }> {
  const sum = input.lines.reduce((s, l) => s + l.amount_cents, 0);
  if (input.lines.length < 2 || sum !== 0 || input.lines.some((l) => !Number.isSafeInteger(l.amount_cents) || l.amount_cents === 0)) {
    throw new LedgerError(500, "A journal must balance in whole cents.");
  }
  const { data, error } = await db.rpc("post_party_journal", {
    p_workspace: input.workspaceId,
    p_kind: input.kind,
    p_key: input.key,
    p_source_type: input.sourceType ?? null,
    p_source_id: input.sourceId ?? null,
    p_stripe: input.stripeObjectId ?? null,
    p_detail: input.detail ?? {},
    p_lines: input.lines,
    p_posted_at: input.postedAt ?? null,
  });
  const result = data as { created?: boolean; journal_id?: string } | null;
  if (error || !result?.journal_id) {
    throw new LedgerError(500, error?.message?.includes("different lines") ? "This money event was already recorded differently." : "Could not record the money movement.");
  }
  return { created: result.created === true, journalId: result.journal_id };
}

export type JournalRow = {
  id: string;
  kind: string;
  workspaceId: string | null;
  postedAt: string;
  sourceType: string | null;
  sourceId: string | null;
  stripeObjectId: string | null;
  detail: Record<string, unknown>;
};

export type LedgerLineRow = {
  journalId: string;
  account: LedgerAccount;
  partyId: string | null;
  workspaceId: string | null;
  amountCents: number;
  availableOn: string | null;
  postedAt: string;
  kind: string;
  detail: Record<string, unknown>;
  sourceType: string | null;
  sourceId: string | null;
};

type Raw = Record<string, unknown>;

/** Rows per page and the page budget for a party's ledger history (1,000,000 lines is far past any real workspace). */
const LEDGER_PAGE_SIZE = 1000;
const LEDGER_MAX_PAGES = 1000;

/**
 * A party's payable lines joined to their journals, oldest first, within a posted-at window. The statement folds these; nothing
 * else computes a party's history.
 */
export async function readPartyLines(
  db: SupabaseClient,
  input: { account: "owner_payable" | "vendor_payable"; partyId: string; workspaceId?: string | null; fromIso?: string; toIso?: string },
): Promise<LedgerLineRow[]> {
  // The window is applied in SQL and the read is PAGED in a stable order: a bare `.limit()` truncated a long
  // history to an arbitrary 5000 rows BEFORE the window narrowed it, so a balance, a statement total or a
  // vendor's 1099 silently came out short once a workspace crossed that many lines.
  const page = (from: number) => {
    let q = db
      .from("party_ledger_lines")
      .select("journal_id, account, party_id, workspace_id, amount_cents, available_on, created_at, party_ledger_journals!inner(kind, posted_at, detail, source_type, source_id)")
      .eq("account", input.account)
      .eq("party_id", input.partyId);
    if (input.workspaceId) q = q.eq("workspace_id", input.workspaceId);
    if (input.fromIso) q = q.gte("party_ledger_journals.posted_at", input.fromIso);
    if (input.toIso) q = q.lt("party_ledger_journals.posted_at", input.toIso);
    return q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + LEDGER_PAGE_SIZE - 1);
  };
  const raw: Raw[] = [];
  for (let pageIndex = 0; pageIndex < LEDGER_MAX_PAGES; pageIndex += 1) {
    const { data, error } = await page(pageIndex * LEDGER_PAGE_SIZE);
    if (error) {
      if (isMissingSchemaError(error)) return [];
      throw new LedgerError(500, "Could not read the ledger.");
    }
    const batch = (data ?? []) as Raw[];
    raw.push(...batch);
    if (batch.length < LEDGER_PAGE_SIZE) break;
  }
  const rows: LedgerLineRow[] = raw.map((r) => {
    const j = (Array.isArray(r.party_ledger_journals) ? r.party_ledger_journals[0] : r.party_ledger_journals) as Raw;
    return {
      journalId: String(r.journal_id),
      account: r.account as LedgerAccount,
      partyId: (r.party_id as string | null) ?? null,
      workspaceId: (r.workspace_id as string | null) ?? null,
      amountCents: Number(r.amount_cents),
      availableOn: (r.available_on as string | null) ?? null,
      postedAt: String(j?.posted_at ?? ""),
      kind: String(j?.kind ?? ""),
      detail: (j?.detail as Record<string, unknown>) ?? {},
      sourceType: (j?.source_type as string | null) ?? null,
      sourceId: (j?.source_id as string | null) ?? null,
    };
  });
  return rows.sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.journalId.localeCompare(b.journalId));
}
