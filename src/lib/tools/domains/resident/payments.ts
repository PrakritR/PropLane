import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../../audit";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import type { HouseholdCharge } from "@/lib/household-charges";
import { canPayHouseholdChargeWithManualChannel } from "@/lib/platform/resident-payments";
import { reportResidentManualPayment } from "@/lib/resident-manual-payment.server";
import { getStripe } from "@/lib/stripe";
import { stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";
import { resolveAndValidateManagerConnectForPayments } from "@/lib/stripe-connect";
import { householdChargeAmountCents } from "@/lib/stripe-household-charge";
import {
  createHouseholdChargeCheckout,
  loadHouseholdChargesForCheckout,
  MAX_BULK_CHARGES,
} from "@/lib/stripe-household-charge-checkout.server";
import { loadOwnCharges } from "./balance";

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const channelLabel = (channel: "zelle" | "venmo") => (channel === "venmo" ? "Venmo" : "Zelle");

export const reportManualPaymentTool = defineWriteTool({
  name: "report_manual_payment",
  description:
    "Report that the resident already sent payment for one or more of their pending charges via Zelle or Venmo, so the manager can verify and mark them paid. Pass charge ids from list_my_charges. The charges stay pending until the manager confirms receipt.",
  inputSchema: z
    .object({
      chargeIds: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_BULK_CHARGES)
        .describe("Ids of your pending charges (from list_my_charges) that you paid manually."),
      channel: z.enum(["zelle", "venmo"]).describe("The manual payment channel actually used."),
    })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    const own = await loadOwnCharges(ctx);
    const uniqueIds = [...new Set(input.chargeIds.map((id) => id.trim()).filter(Boolean))];
    const resolved: HouseholdCharge[] = [];
    const invalid: string[] = [];
    for (const id of uniqueIds) {
      const charge = own.find((c) => c.id === id && c.status === "pending");
      if (!charge) {
        invalid.push(id);
        continue;
      }
      if (!canPayHouseholdChargeWithManualChannel(charge, input.channel)) {
        throw new Error(`Charge ${id} ("${charge.title}") cannot be paid with ${channelLabel(input.channel)} — that channel is not offered on this charge. Check zelleAvailable/venmoAvailable in list_my_charges.`);
      }
      resolved.push(charge);
    }
    if (invalid.length > 0) {
      throw new Error(`These ids are not your pending charges: ${invalid.join(", ")}. Use list_my_charges to get valid charge ids.`);
    }
    const totalCents = resolved.reduce((sum, c) => sum + householdChargeAmountCents(c), 0);
    return {
      confirmedInput: { chargeIds: resolved.map((c) => c.id), channel: input.channel },
      kind: "report_manual_payment",
      title: `Report ${channelLabel(input.channel)} payment`,
      summary: `Tell your manager you sent ${centsLabel(totalCents)} via ${channelLabel(input.channel)} for ${resolved.length} charge${resolved.length === 1 ? "" : "s"}. The charge${resolved.length === 1 ? "" : "s"} stay pending until they confirm receipt.`,
      fields: [
        ...resolved.map((c) => ({ label: c.title || c.id, value: c.balanceLabel || c.amountLabel || "—" })),
        { label: "Total", value: centsLabel(totalCents) },
      ],
      confirmLabel: "Report payment",
      ...(resolved.length > 1 ? { batchCount: resolved.length } : {}),
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    // Re-resolve every id against the resident's own pending charges.
    const own = await loadOwnCharges(ctx);
    const uniqueIds = [...new Set(input.chargeIds.map((id) => id.trim()).filter(Boolean))];
    const fresh: string[] = [];
    const freshKeys: string[] = [];
    let alreadyReported = 0;
    let skipped = 0;
    for (const id of uniqueIds) {
      const charge = own.find((c) => c.id === id && c.status === "pending");
      if (!charge || !canPayHouseholdChargeWithManualChannel(charge, input.channel)) {
        skipped += 1;
        continue;
      }
      // Record intent per charge, idempotent per day.
      const dedupeKey = `report_manual_payment:${ctx.landlordId}:${id}:${auditDayBucket()}`;
      const audit = await writeAuditLog(ctx, {
        action: "report_manual_payment",
        toolName: "report_manual_payment",
        inputSummary: { chargeId: id, channel: input.channel },
        dedupeKey,
      });
      if (!audit.recorded) {
        if (audit.duplicate) {
          alreadyReported += 1;
          continue;
        }
        throw new Error("Could not record the action; no payment was reported.");
      }
      fresh.push(id);
      freshKeys.push(dedupeKey);
    }

    if (fresh.length === 0) {
      if (alreadyReported > 0) {
        return { reply: "These payments were already reported today — your manager has been notified." };
      }
      throw new Error("No matching pending charges remained to report. Use list_my_charges to check ids.");
    }

    const result = await reportResidentManualPayment(ctx.db, {
      userId: ctx.userId,
      userEmail: ctx.email,
      chargeIds: fresh,
      channel: input.channel,
      expectedManagerUserId: ctx.activeManagerId,
    });
    if (!result.ok) {
      // Allow a same-day retry after a hard failure.
      for (const key of freshKeys) {
        await updateAuditResult(ctx, key, { failed: true }, { clearDedupeKey: true });
      }
      throw new Error(result.error);
    }
    for (const key of freshKeys) {
      await updateAuditResult(ctx, key, { channel: input.channel, reported: true });
    }

    const parts = [
      `reported ${result.charges.length} payment${result.charges.length === 1 ? "" : "s"} via ${channelLabel(input.channel)}`,
    ];
    if (alreadyReported) parts.push(`${alreadyReported} already reported today`);
    if (skipped) parts.push(`${skipped} no longer pending and skipped`);
    return { reply: `Done — ${parts.join("; ")}. Your manager will verify and mark the charge${result.charges.length === 1 ? "" : "s"} paid.`, resultSummary: { reported: result.charges.length, alreadyReported, skipped, channel: input.channel } };
  },
});

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
