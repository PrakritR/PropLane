import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog } from "../../audit";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { residentChargesListHref } from "@/lib/portal-detail-routes";
import { getStripe } from "@/lib/stripe";
import { stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";
import { resolveAndValidateManagerConnectForPayments } from "@/lib/stripe-connect";
import { householdChargeAmountCents } from "@/lib/stripe-household-charge";
import { loadHouseholdChargesForCheckout, MAX_BULK_CHARGES } from "@/lib/stripe-household-charge-checkout.server";

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The resident's own in-app Payments path — never a hosted Stripe checkout
 * link. Every payment happens inside PropLane; this tool only points there. */
function residentPaymentsInAppUrl(): string {
  return `${resolveShareableAppOrigin()}${residentChargesListHref("/resident", "pending")}`;
}

export const startRentPaymentTool = defineWriteTool({
  name: "start_rent_payment",
  description:
    "Point the resident to pay one or more of their pending charges in PropLane's own Payments page (never a hosted checkout link). Pass charge ids from list_my_charges; all charges must belong to the same property manager.",
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
      title: "Pay charges in PropLane",
      summary: `Pay ${centsLabel(totalCents)} for ${resolved.loaded.length} charge${resolved.loaded.length === 1 ? "" : "s"} — this opens Payments in PropLane for exactly that amount, with no added fees.`,
      fields: [
        ...resolved.loaded.map((row) => ({
          label: row.charge.title || row.id,
          value: row.charge.balanceLabel || row.charge.amountLabel || "—",
        })),
        // Face value: PropLane covers payment processing, so the amount
        // collected is the sum of the charge balances above.
        { label: "Added fees", value: centsLabel(0) },
        { label: "Total due", value: centsLabel(totalCents) },
        { label: "Payment", value: "Opens Payments in PropLane" },
      ],
      confirmLabel: "Open Payments",
      ...(resolved.loaded.length > 1 ? { batchCount: resolved.loaded.length } : {}),
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    // Repeatable action (no dedupe key) — audit-logged so re-pointing the
    // resident to Payments is always allowed, even if they already visited.
    const audit = await writeAuditLog(ctx, {
      action: "start_rent_payment",
      toolName: "start_rent_payment",
      inputSummary: { chargeIds: input.chargeIds, chargeCount: input.chargeIds.length },
    });
    if (!audit.recorded) {
      throw new Error("Could not record the action.");
    }

    // Re-validate ownership/paid/manager from live data, exactly as preview
    // did — never trust the confirmed input alone — but never mint a hosted
    // checkout session. The resident always pays inside PropLane's own
    // Payments page.
    const resolved = await loadHouseholdChargesForCheckout(ctx.db, {
      userId: ctx.userId,
      userEmail: ctx.email,
      chargeIds: input.chargeIds,
      expectedManagerUserId: ctx.activeManagerId,
    });
    if (!resolved.ok) throw new Error(resolved.error);

    const totalCents = resolved.loaded.reduce((sum, row) => sum + householdChargeAmountCents(row.charge), 0);
    const paymentsUrl = residentPaymentsInAppUrl();

    return {
      reply: `Open Payments to pay in PropLane — ${centsLabel(totalCents)} total, with no added fees, for ${resolved.loaded.length} charge${resolved.loaded.length === 1 ? "" : "s"}.`,
      checkoutUrl: paymentsUrl,
      resultSummary: { chargeCount: resolved.loaded.length, totalCents },
    };
  },
});
