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
import { listResidentSavedPaymentMethods } from "@/lib/stripe-resident-customer";
import {
  autopayNextScheduledChargeLabel,
  resolveResidentAutopayHousehold,
  saveResidentAutopaySettings,
} from "@/lib/resident-autopay.server";
import { loadWorkspacePaymentSettingsForProperty, workspaceAutopayEnabled } from "@/lib/workspace-payment-settings.server";
import { formatPacificDate } from "@/lib/pacific-time";

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function loadResidentStripeCustomerId(ctx: ResidentAgentContext): Promise<string | null> {
  const { data } = await ctx.db.from("profiles").select("stripe_customer_id").eq("id", ctx.userId).maybeSingle();
  return data?.stripe_customer_id?.trim() || null;
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

/**
 * Portal-only (see `PORTAL_ONLY_TOOLS` in resident-index.ts) — autopay is a
 * standing enrollment change, not something to confirm blind over SMS. Turns
 * autopay on/off (and the run-days-before-due) for the resident's current
 * household, reusing the exact same household resolution and settings writer
 * the /api/resident/autopay route uses, so chat and the Payments page can
 * never disagree about what "on" means.
 */
export const setAutopayTool = defineWriteTool({
  name: "set_autopay",
  description:
    "Turn autopay on or off for the resident's rent and recurring charges (utilities), or change how many days before the due date it runs (0-5). One-off charges (fees, deposits) are never covered by autopay.",
  inputSchema: z
    .object({
      enabled: z.boolean().describe("true to turn autopay on, false to turn it off."),
      daysBeforeDue: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("How many days before the due date autopay runs (0 = on the due date). Ignored when enabled is false."),
    })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    const managerId = ctx.activeManagerId ?? ctx.managerIds[0];
    if (!managerId) throw new Error("No linked property manager found.");
    const household = await resolveResidentAutopayHousehold(ctx.db, { residentEmail: ctx.email, managerId });
    if (!household) throw new Error("You don't have any recurring rent or utility charges to enroll yet.");

    if (input.enabled) {
      const workspaceSettings = await loadWorkspacePaymentSettingsForProperty(ctx.db, managerId, household.propertyId);
      if (!workspaceAutopayEnabled(workspaceSettings)) {
        throw new Error("Your property manager has turned off autopay.");
      }
      const stripeCustomerId = await loadResidentStripeCustomerId(ctx);
      if (!stripeCustomerId) {
        throw new Error("Add a bank or card on the Payments page before turning on autopay.");
      }
      const methods = await listResidentSavedPaymentMethods(getStripe(), stripeCustomerId);
      const method = methods.find((m) => m.isDefault) ?? methods[0];
      if (!method) {
        throw new Error("Add a bank or card on the Payments page before turning on autopay.");
      }
      const runDaysBeforeDue = input.daysBeforeDue ?? 0;
      const nextCharge = autopayNextScheduledChargeLabel(household.nextCharge, runDaysBeforeDue, (date) =>
        formatPacificDate(date, { month: "short", day: "numeric" }),
      );
      return {
        confirmedInput: input,
        kind: "set_autopay",
        title: "Turn on autopay",
        summary: `Autopay will pay rent and utilities using ${method.label}, ${runDaysBeforeDue === 0 ? "on the due date" : `${runDaysBeforeDue} day${runDaysBeforeDue === 1 ? "" : "s"} before it's due`}.`,
        fields: [
          { label: "Pays with", value: method.label },
          { label: "Runs", value: runDaysBeforeDue === 0 ? "On the due date" : `${runDaysBeforeDue} day${runDaysBeforeDue === 1 ? "" : "s"} before due` },
          ...(nextCharge ? [{ label: "Next payment", value: nextCharge }] : []),
        ],
        confirmLabel: "Turn on autopay",
      };
    }

    return {
      confirmedInput: input,
      kind: "set_autopay",
      title: "Turn off autopay",
      summary: "Autopay will stop paying rent and utilities automatically. You'll need to pay each charge yourself.",
      fields: [{ label: "Autopay", value: "Off" }],
      confirmLabel: "Turn off autopay",
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const audit = await writeAuditLog(ctx, {
      action: "set_autopay",
      toolName: "set_autopay",
      inputSummary: { enabled: input.enabled, daysBeforeDue: input.daysBeforeDue ?? null },
    });
    if (!audit.recorded) {
      throw new Error("Could not record the action; autopay was not changed.");
    }

    const managerId = ctx.activeManagerId ?? ctx.managerIds[0];
    if (!managerId) throw new Error("No linked property manager found.");
    const household = await resolveResidentAutopayHousehold(ctx.db, { residentEmail: ctx.email, managerId });
    if (!household) throw new Error("You don't have any recurring rent or utility charges to enroll yet.");

    let paymentMethodId: string | null = null;
    if (input.enabled) {
      const workspaceSettings = await loadWorkspacePaymentSettingsForProperty(ctx.db, managerId, household.propertyId);
      if (!workspaceAutopayEnabled(workspaceSettings)) {
        throw new Error("Your property manager has turned off autopay.");
      }
      const stripeCustomerId = await loadResidentStripeCustomerId(ctx);
      if (!stripeCustomerId) {
        throw new Error("Add a bank or card on the Payments page before turning on autopay.");
      }
      const methods = await listResidentSavedPaymentMethods(getStripe(), stripeCustomerId);
      const method = methods.find((m) => m.isDefault) ?? methods[0];
      if (!method) {
        throw new Error("Add a bank or card on the Payments page before turning on autopay.");
      }
      paymentMethodId = method.id;
    }

    const saved = await saveResidentAutopaySettings(ctx.db, {
      residentUserId: ctx.userId,
      managerId,
      householdKey: household.householdKey,
      enabled: input.enabled,
      paymentMethodId,
      runDaysBeforeDue: input.daysBeforeDue ?? 0,
    });

    return {
      reply: saved.enabled
        ? "Autopay is on for your rent and utility charges."
        : "Autopay is now off. You'll need to pay each charge yourself.",
      resultSummary: { enabled: saved.enabled, runDaysBeforeDue: saved.runDaysBeforeDue },
    };
  },
});
