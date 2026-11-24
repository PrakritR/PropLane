import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { CountryCode, Products, type PlaidApi, type Transaction } from "plaid";
import { estimateMonthlyIncome, INCOME_LOOKBACK_MONTHS, type IncomeEstimateRefusal } from "@/lib/plaid/income-calc";
import { getPlaidClient, plaidEnabled, plaidFailure } from "@/lib/plaid/client.server";
import { resolveApplicantScreeningSettings } from "@/lib/screening/applicant-screening-settings.server";
import {
  isIncomeVerification,
  isIncomeVerificationFresh,
  type IncomeVerification,
} from "@/lib/screening/income-verification";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Applicant income check (Plaid purpose `income`). Method: Plaid Link with the Transactions product, then
 * `/transactions/get` over the last 3 months, then payroll-style deposits averaged per month (`income-calc.ts`).
 * Plaid's own Income products (`/credit/bank_income/get`) need separate product access; this works on a plain
 * Transactions-enabled account, sandbox included.
 *
 * No access token is ever stored: the Item is removed the moment the figure is computed, so nothing lingers. The
 * figure goes to `applicant_income_verifications` (service role only) and is stamped onto the application by the
 * signed-in write; the browser never supplies it. No decision is tied to it (FCRA: counsel review pending).
 */

export type IncomeActor =
  | { ok: true; userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; status: number; error: string };

/** The signed-in applicant. A guest has no session, so a guest never reaches the check (the skip path stays). */
export async function authorizeIncomeActor(): Promise<IncomeActor> {
  if (!plaidEnabled()) return { ok: false, status: 404, error: "Not found." };
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user?.id) return { ok: false, status: 401, error: "Unauthorized." };
  return { ok: true, userId: user.id, db: createSupabaseServiceRoleClient() };
}

/** True when Plaid is on AND this listing's setting offers the check. The listing owner is read from the database. */
export async function incomeCheckOffered(db: SupabaseClient, propertyId: string): Promise<boolean> {
  if (!plaidEnabled()) return false;
  const id = propertyId.trim();
  if (!id || id.length > 200) return false;
  const { data, error } = await db.from("manager_property_records").select("id, manager_user_id").eq("id", id).maybeSingle();
  const managerUserId = String(data?.manager_user_id ?? "").trim();
  if (error || !data || !managerUserId) return false;
  try {
    const { settings } = await resolveApplicantScreeningSettings(db, { managerUserId, propertyId: id });
    return settings.verifyIncomeWithPlaid === true;
  } catch {
    return false;
  }
}

/** Link token for the income check: transactions product, 90 days, no webhook (the item is removed straight away). */
export async function createIncomeLinkToken(userId: string, client: Pick<PlaidApi, "linkTokenCreate"> = getPlaidClient()): Promise<string> {
  const res = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "PropLane",
    language: "en",
    country_codes: [CountryCode.Us],
    products: [Products.Transactions],
    transactions: { days_requested: 90 },
  });
  return res.data.link_token;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type IncomeClient = Pick<
  PlaidApi,
  "itemPublicTokenExchange" | "transactionsGet" | "itemRemove" | "accountsGet" | "institutionsGetById"
>;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The bank the figure was read from, for the stored provenance of the verification. Best effort:
 * the applicant's income figure is never lost to a failed institution lookup.
 */
async function readInstitutionName(client: IncomeClient, accessToken: string): Promise<string | null> {
  try {
    const accounts = await client.accountsGet({ access_token: accessToken });
    const institutionId = accounts.data.item.institution_id;
    if (!institutionId) return null;
    const inst = await client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
    return inst.data.institution.name.trim().slice(0, 120) || null;
  } catch {
    return null;
  }
}

async function readTransactions(client: IncomeClient, accessToken: string, now: Date, wait: (ms: number) => Promise<void>): Promise<Transaction[]> {
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const all: Transaction[] = [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      let offset = 0;
      for (;;) {
        const res = await client.transactionsGet({
          access_token: accessToken,
          start_date: isoDay(start),
          end_date: isoDay(now),
          options: { count: 500, offset },
        });
        all.push(...res.data.transactions);
        offset += res.data.transactions.length;
        if (res.data.transactions.length === 0 || offset >= res.data.total_transactions) return all;
      }
    } catch (error) {
      // A brand-new Item has no history for a few seconds.
      if (plaidFailure(error).code === "PRODUCT_NOT_READY" && attempt < 6) {
        all.length = 0;
        await wait(2000);
        continue;
      }
      throw error;
    }
  }
}

export type IncomeComputeResult =
  | { ok: true; verification: IncomeVerification }
  | { ok: false; status: number; error: string };

/**
 * One message per refusal reason. An applicant whose bank shared too little history is told that, not
 * that no paychecks were found — they can try the account their pay actually lands in, and the manager
 * asking why there is no figure gets the true answer. Skipping to pay stubs stays available either way.
 */
const INCOME_REFUSAL_MESSAGE: Record<IncomeEstimateRefusal, string> = {
  no_payroll_deposits: "We couldn't find regular paychecks in that account.",
  not_enough_history: "That account doesn't have enough paycheck history yet.",
};

/**
 * Exchange the Link public token, read 90 days of transactions, compute the figure, remove the Item. The Item is
 * removed in a `finally`: a failure at any step still leaves no access token behind.
 */
export async function computeIncomeFromPublicToken(
  input: { publicToken: string; now?: Date; wait?: (ms: number) => Promise<void> },
  client: IncomeClient = getPlaidClient(),
): Promise<IncomeComputeResult> {
  const now = input.now ?? new Date();
  const wait = input.wait ?? sleep;
  const exchanged = await client.itemPublicTokenExchange({ public_token: input.publicToken });
  const accessToken = exchanged.data.access_token;
  try {
    const transactions = await readTransactions(client, accessToken, now, wait);
    const outcome = estimateMonthlyIncome(transactions, INCOME_LOOKBACK_MONTHS, now);
    if (!outcome.ok) return { ok: false, status: 422, error: INCOME_REFUSAL_MESSAGE[outcome.reason] };
    const estimate = outcome.estimate;
    return {
      ok: true,
      verification: {
        source: "plaid",
        monthlyIncomeCents: estimate.monthlyIncomeCents,
        months: estimate.months,
        depositCount: estimate.depositCount,
        verifiedAt: now.toISOString(),
        institutionName: await readInstitutionName(client, accessToken),
      },
    };
  } finally {
    try {
      await client.itemRemove({ access_token: accessToken });
    } catch (error) {
      console.warn("[plaid] income item remove failed", plaidFailure(error).code);
    }
  }
}

export async function saveIncomeVerification(
  db: SupabaseClient,
  input: { userId: string; propertyId: string; verification: IncomeVerification },
): Promise<void> {
  const v = input.verification;
  const { error } = await db.from("applicant_income_verifications").upsert(
    {
      user_id: input.userId,
      property_id: input.propertyId,
      monthly_income_cents: v.monthlyIncomeCents,
      months: v.months,
      deposit_count: v.depositCount,
      institution_name: v.institutionName ?? null,
      verified_at: v.verifiedAt,
    },
    { onConflict: "user_id,property_id" },
  );
  if (error) throw new Error(error.message);
}

/** The applicant's fresh verification for a listing, or null (also null when the table cannot be read). */
export async function loadIncomeVerification(
  db: SupabaseClient,
  userId: string,
  propertyId: string,
  now: Date = new Date(),
): Promise<IncomeVerification | null> {
  const id = propertyId.trim();
  if (!userId || !id) return null;
  const { data, error } = await db
    .from("applicant_income_verifications")
    .select("monthly_income_cents, months, deposit_count, institution_name, verified_at")
    .eq("user_id", userId)
    .eq("property_id", id)
    .maybeSingle();
  if (error || !data) return null;
  const candidate = {
    source: "plaid" as const,
    monthlyIncomeCents: Number(data.monthly_income_cents),
    months: Number(data.months),
    depositCount: Number(data.deposit_count ?? 0),
    verifiedAt: new Date(String(data.verified_at)).toISOString(),
    institutionName: typeof data.institution_name === "string" ? data.institution_name : null,
  };
  return isIncomeVerification(candidate) && isIncomeVerificationFresh(candidate, now) ? candidate : null;
}
