import { z } from "zod";
import { defineTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import type { HouseholdCharge } from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";
import { queryResidentBalance } from "@/lib/resident-balance-summary.server";
import { queryResidentLedger } from "@/lib/reports/queries";
import { listResidentSavedPaymentMethods } from "@/lib/stripe-resident-customer";
import { getStripe } from "@/lib/stripe";
import { loadResidentIdentityRows } from "./load-resident-rows";

/** Server-side read of the resident's own charges (resident_user_id OR resident_email). */
export async function loadOwnCharges(ctx: ResidentAgentContext): Promise<HouseholdCharge[]> {
  return loadResidentIdentityRows(ctx, "portal_household_charge_records", (rowData) => rowData as HouseholdCharge);
}

export const getMyBalanceTool = defineTool({
  name: "get_my_balance",
  description:
    "Get the resident's current balance summary (amount due, next charge and due date, last payment) plus their 10 most recent ledger entries. Use for 'what do I owe', 'when is rent due', 'did my payment go through'.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    const [balance, ledger] = await Promise.all([
      queryResidentBalance(ctx.db, ctx.userId, ctx.email, ctx.activeManagerId),
      queryResidentLedger(ctx.db, ctx.userId, ctx.email, {}, ctx.activeManagerId),
    ]);
    return {
      summary: balance.rows,
      balanceCents: Number(balance.meta?.balanceCents ?? 0),
      recentLedger: ledger.rows.slice(-10),
    };
  },
});

/** Safe projection of the resident's own charge. */
function summarizeOwnCharge(c: HouseholdCharge) {
  return {
    id: c.id,
    kind: c.kind || null,
    title: c.title || null,
    property: c.propertyLabel || null,
    amount: c.amountLabel || null,
    balance: c.balanceLabel || null,
    status: c.status || null,
    dueDate: c.dueDateLabel || null,
    paidAt: c.paidAt || null,
  };
}

export const listMyChargesTool = defineTool({
  name: "list_my_charges",
  description:
    "List the resident's own charges (rent, deposits, fees) with id, title, amount, balance, status, and due date. Use this to collect charge ids for start_rent_payment, and for 'what charges do I have'.",
  kind: "read",
  inputSchema: z
    .object({
      status: z
        .enum(["pending", "paid"])
        .optional()
        .describe("Optional filter on charge status."),
    })
    .strict(),
  handler: async (ctx: ResidentAgentContext, input) => {
    // Same visibility set the resident's own Payments screen applies
    // (`residentVisibleCharges`, `resident-payments-panel.tsx`) — the assistant
    // should never talk about a charge before the resident can see it there,
    // and never omit a move-in line the screen shows.
    const charges = residentVisibleCharges(await loadOwnCharges(ctx))
      .filter((c) => !input.status || c.status === input.status)
      .map(summarizeOwnCharge);
    return { count: charges.length, charges };
  },
});

export const getMyPaymentMethodsTool = defineTool({
  name: "get_my_payment_methods",
  description:
    "List the resident's saved payment methods on file (card/bank brand and last 4 digits only). Use for 'what payment methods do I have saved'. Never returns full account or card numbers.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    const { data: profile } = await ctx.db
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", ctx.userId)
      .maybeSingle();
    const customerId = String(profile?.stripe_customer_id ?? "").trim();
    if (!customerId) {
      return { count: 0, paymentMethods: [], note: "No saved payment methods on file." };
    }
    let stripe;
    try {
      stripe = getStripe();
    } catch {
      return { count: 0, paymentMethods: [], note: "Payments are not configured on this server." };
    }
    const methods = await listResidentSavedPaymentMethods(stripe, customerId);
    // Brand + last4 only (from the label); Stripe payment-method ids stay internal.
    const paymentMethods = methods.map((m) => ({ type: m.type, label: m.label, isDefault: m.isDefault }));
    return { count: paymentMethods.length, paymentMethods };
  },
});
