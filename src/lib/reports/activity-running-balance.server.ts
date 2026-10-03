import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";
import { getStripe } from "@/lib/stripe";
import type { ReportRow } from "./types";

type Movement = { id: string; at: string; cents: number; reference: string | null };
/** Unknown/offline movements never change a provider balance. */
export function annotateRunningBalances(rows: ReportRow[], movements: Movement[], closingCents: number): void {
  if (!Number.isSafeInteger(closingCents)) throw new Error("Invalid closing balance.");
  let balance = closingCents;
  const matched = new Set<string>();
  for (const movement of [...movements].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    if (!Number.isSafeInteger(movement.cents)) throw new Error("Invalid balance movement.");
    if (movement.reference && !matched.has(movement.reference)) {
      const references = rows.filter(row => row.runningBalanceCents === undefined && String(row.balanceReferences ?? "").split("|").includes(movement.reference!));
      // Several accounting lines may share one Stripe object. Only the final
      // displayed line receives its actual post-transaction balance.
      if (references.length) {
        references[references.length - 1].runningBalanceCents = balance;
        matched.add(movement.reference);
      }
    }
    balance -= movement.cents;
    if (!Number.isSafeInteger(balance)) throw new Error("Balance exceeds supported precision.");
  }
}

/** Reads historical provider deltas, never derives balance from rent or expenses. */
export async function loadActivityRunningBalances(db: SupabaseClient, owner: string, rows: ReportRow[]): Promise<void> {
  if (!rows.length) return;
  if (proplaneBalanceEnabled()) {
    const { data: account, error } = await db.from("proplane_balance_accounts").select("id").eq("owner_kind", "workspace").eq("owner_key", owner).eq("currency", "usd").maybeSingle();
    if (error) throw new Error(error.message);
    if (!account) return;
    const movements: Movement[] = [];
    let closing = 0;
    for (let offset = 0; ; offset += 500) {
      const { data, error: readError } = await db.from("proplane_balance_entries").select("id, created_at, amount_cents, idempotency_key, stripe_object_id").eq("account_id", account.id).order("id").range(offset, offset + 499);
      if (readError) throw new Error(readError.message);
      for (const entry of data ?? []) {
        const cents = Number(entry.amount_cents);
        if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(closing + cents)) throw new Error("Invalid balance ledger amount.");
        closing += cents;
        movements.push({ id: entry.id, at: entry.created_at, cents, reference: entry.idempotency_key || entry.stripe_object_id });
      }
      if (!data || data.length < 500) break;
    }
    annotateRunningBalances(rows, movements, closing);
    return;
  }
  if ((await resolveTestWorkspaceClassification(owner, db)).kind !== "normal") return;
  const { data: profile, error } = await db.from("profiles").select("stripe_connect_account_id").eq("id", owner).maybeSingle();
  if (error) throw new Error(error.message);
  if (!profile?.stripe_connect_account_id) return;
  const options = { stripeAccount: String(profile.stripe_connect_account_id) };
  const stripe = getStripe();
  const balance = await stripe.balance.retrieve(options);
  const closing = [...balance.available, ...balance.pending].filter(value => value.currency === "usd").reduce((total, value) => total + value.amount, 0);
  const earliest = Math.min(...rows.map(row => Date.parse(String(row.date))).filter(Number.isFinite));
  if (!Number.isFinite(earliest)) return;
  const movements: Movement[] = [];
  for await (const entry of stripe.balanceTransactions.list({ limit: 100, created: { gte: Math.floor(earliest / 1000) } }, options)) {
    if (entry.currency !== "usd") continue;
    movements.push({ id: entry.id, at: new Date(entry.created * 1000).toISOString(), cents: entry.net, reference: typeof entry.source === "string" ? entry.source : entry.source?.id ?? null });
  }
  // Stripe reads are not a database transaction. Do not publish an anchor
  // that changed while its history was being read.
  const after = await stripe.balance.retrieve(options);
  const verified = [...after.available, ...after.pending].filter(value => value.currency === "usd").reduce((total, value) => total + value.amount, 0);
  if (verified === closing) annotateRunningBalances(rows, movements, closing);
}
