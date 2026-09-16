import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog } from "../../audit";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { getStripe } from "@/lib/stripe";
import { stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";
import { resolveAndValidateManagerConnectForPayments } from "@/lib/stripe-connect";
import { householdChargeAmountCents } from "@/lib/stripe-household-charge";
import {
  createHouseholdChargeCheckout,
  loadHouseholdChargesForCheckout,
  MAX_BULK_CHARGES,
} from "@/lib/stripe-household-charge-checkout.server";

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const startRentPaymentTool = defineWriteTool({
  name: "start_rent_payment",
  description:
    "Start an online bank (ACH) payment for one or more of the resident's pending charges by creating a secure Stripe Checkout session and returning its link. Pass charge ids from list_my_charges; all charges must belong to the same property manager.",
  inputSchema: z
    .object({
      chargeIds: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_BULK_CHARGES)
        .describe("Ids of your pending charges (from list_my_charges) to pay together."),
    })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    // Same validation the checkout route runs: ownership, not paid, ACH enabled
    // on each listing, single owning manager.
    const resolved = await loadHouseholdChargesForCheckout(ctx.db, {
      userId: ctx.userId,
      userEmail: ctx.email,
      chargeIds: input.chargeIds,
      expectedManagerUserId: ctx.activeManagerId,
    });
    if (!resolved.ok) throw new Error(resolved.error);

    // Honest preview error when the manager's Stripe payouts aren't ready.
    try {
      const connect = await resolveAndValidateManagerConnectForPayments(getStripe(), ctx.db, resolved.managerUserId);
      if (!connect.ok) throw new Error(connect.error);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Stripe validation failed.";
      if (stripeNotConfiguredError(message)) {
        throw new Error("Online payments are not configured on this server.");
      }
      throw new Error(message);
    }

    const totalCents = resolved.loaded.reduce((sum, row) => sum + householdChargeAmountCents(row.charge), 0);
    return {
      confirmedInput: { chargeIds: resolved.loaded.map((row) => row.id) },
      kind: "start_rent_payment",
      title: "Pay charges online",
      summary: `Pay ${centsLabel(totalCents)} for ${resolved.loaded.length} charge${resolved.loaded.length === 1 ? "" : "s"} — this opens a secure Stripe checkout for exactly that amount, with no added fees.`,
      fields: [
        ...resolved.loaded.map((row) => ({
          label: row.charge.title || row.id,
          value: row.charge.balanceLabel || row.charge.amountLabel || "—",
        })),
        // Face value: PropLane covers payment processing, so the amount Stripe
        // collects is the sum of the charge balances above.
        { label: "Added fees", value: centsLabel(0) },
        { label: "Total due", value: centsLabel(totalCents) },
        { label: "Payment", value: "Opens secure Stripe checkout" },
      ],
      confirmLabel: "Open checkout",
      ...(resolved.loaded.length > 1 ? { batchCount: resolved.loaded.length } : {}),
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    // Repeatable action (sessions expire unused) — audit-logged without a
    // dedupe key so a fresh checkout can always be created.
    const audit = await writeAuditLog(ctx, {
      action: "start_rent_payment",
      toolName: "start_rent_payment",
      inputSummary: { chargeIds: input.chargeIds, chargeCount: input.chargeIds.length },
    });
    if (!audit.recorded) {
      throw new Error("Could not record the action; no checkout was created.");
    }

    // The lib re-validates ownership/paid/manager/Connect from live data.
    const result = await createHouseholdChargeCheckout(ctx.db, {
      userId: ctx.userId,
      userEmail: ctx.email,
      chargeIds: input.chargeIds,
      mode: "hosted",
      paymentMethod: "ach",
      expectedManagerUserId: ctx.activeManagerId,
      appOrigin: resolveShareableAppOrigin(),
    });
    if (!result.ok) throw new Error(result.error);
    if (result.mode !== "hosted" || !result.url) {
      throw new Error("Checkout session was created without a hosted payment link.");
    }

    return { reply: `Your secure Stripe checkout is ready — ${centsLabel(result.totalCents)} total, with no added fees, for ${result.chargeIds.length} charge${result.chargeIds.length === 1 ? "" : "s"}. Open the link to pay.`, checkoutUrl: result.url, resultSummary: { chargeCount: result.chargeIds.length, totalCents: result.totalCents } };
  },
});
