/**
 * Admin agent: Stripe-backed reads (earnings, promotion codes). Read-only.
 *
 * Both go through `getStripe()` and only ever LIST. Amounts are Stripe's own
 * integer cents; the model is told to quote them, never to recompute them.
 */
import { z } from "zod";
import { getStripe } from "@/lib/stripe";
import { defineTool } from "../registry";
import type { AdminAgentContext } from "./context";

const PAGE = 100;
/** Hard ceiling on balance transactions read for one summary (50 pages). */
const MAX_BALANCE_TRANSACTIONS = 5_000;
const MAX_PROMO_CODES = 200;

/** Reporting categories that are money coming in to the platform account. */
const REVENUE_CATEGORIES = new Set(["charge", "payment", "application_fee"]);
const REFUND_CATEGORIES = new Set(["refund", "payment_refund", "application_fee_refund"]);
const DISPUTE_CATEGORIES = new Set(["dispute", "dispute_reversal"]);
/** Money that moves between accounts or to the bank, not earned or spent. */
const TRANSFER_CATEGORIES = new Set(["payout", "payout_reversal", "transfer", "transfer_reversal", "topup", "topup_reversal"]);

export type MonthWindow = { month: string; startUnix: number; endUnix: number };

/** `YYYY-MM` (UTC) window; defaults to the current month. Null for a malformed month. */
export function monthWindow(month: string | undefined, now = new Date()): MonthWindow | null {
  const label = month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    month: label,
    startUnix: Math.floor(Date.UTC(year, monthIndex, 1) / 1000),
    endUnix: Math.floor(Date.UTC(year, monthIndex + 1, 1) / 1000),
  };
}

export type BalanceTransactionLike = {
  currency: string;
  amount: number;
  fee: number;
  net: number;
  reporting_category: string;
};

/** Pure roll-up of balance transactions, exported so the arithmetic is unit-tested. */
export function summarizeBalanceTransactions(rows: BalanceTransactionLike[]) {
  let revenueCents = 0;
  let refundsCents = 0;
  let disputesCents = 0;
  let stripeFeesCents = 0;
  const other: Record<string, number> = {};
  for (const row of rows) {
    if (row.currency !== "usd") continue;
    const category = row.reporting_category;
    if (TRANSFER_CATEGORIES.has(category)) continue;
    if (REVENUE_CATEGORIES.has(category)) {
      revenueCents += row.amount;
      stripeFeesCents += row.fee;
    } else if (REFUND_CATEGORIES.has(category)) {
      refundsCents += row.amount;
    } else if (DISPUTE_CATEGORIES.has(category)) {
      disputesCents += row.amount;
      stripeFeesCents += row.fee;
    } else if (category === "fee") {
      stripeFeesCents += -row.amount;
    } else {
      other[category] = (other[category] ?? 0) + row.net;
    }
  }
  return {
    revenueCents,
    refundsCents,
    disputesCents,
    stripeFeesCents,
    netCents: revenueCents + refundsCents + disputesCents - stripeFeesCents,
    other,
  };
}

export const earningsSummaryTool = defineTool({
  name: "earnings_summary",
  description:
    "What PropLane earned in a calendar month (UTC), from Stripe balance transactions on the platform account: revenue, refunds, disputes, Stripe fees and net, in cents. Payouts and transfers are excluded. Defaults to the current month; pass month as YYYY-MM.",
  inputSchema: z.object({
    month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("YYYY-MM. Default: this month."),
  }),
  async handler(_ctx: AdminAgentContext, input) {
    const window = monthWindow(input.month);
    if (!window) throw new Error("month must look like 2026-10.");
    const stripe = getStripe();
    const rows: BalanceTransactionLike[] = [];
    let startingAfter: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await stripe.balanceTransactions.list({
        limit: PAGE,
        created: { gte: window.startUnix, lt: window.endUnix },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const entry of page.data) {
        rows.push({
          currency: entry.currency,
          amount: entry.amount,
          fee: entry.fee,
          net: entry.net,
          reporting_category: entry.reporting_category,
        });
      }
      if (!page.has_more || page.data.length === 0) break;
      if (rows.length >= MAX_BALANCE_TRANSACTIONS) {
        truncated = true;
        break;
      }
      startingAfter = page.data[page.data.length - 1]!.id;
    }
    return {
      month: window.month,
      currency: "usd",
      transactionsRead: rows.length,
      // A truncated read is a floor, not a total: say so instead of presenting it as complete.
      complete: !truncated,
      ...summarizeBalanceTransactions(rows),
    };
  },
});

export const promoCodesSummaryTool = defineTool({
  name: "promo_codes_summary",
  description:
    "Stripe promotion codes with how often each has been redeemed, most used first: code, active, discount, redemptions, limit and expiry.",
  inputSchema: z.object({
    activeOnly: z.boolean().optional().describe("Only codes that can still be redeemed."),
  }),
  async handler(_ctx: AdminAgentContext, input) {
    const stripe = getStripe();
    const codes: {
      code: string;
      active: boolean;
      timesRedeemed: number;
      maxRedemptions: number | null;
      expiresAt: string | null;
      discount: string;
      duration: string | null;
    }[] = [];
    let startingAfter: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await stripe.promotionCodes.list({
        limit: PAGE,
        expand: ["data.promotion.coupon"],
        ...(input.activeOnly ? { active: true } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const promo of page.data) {
        const coupon = promo.promotion?.coupon && typeof promo.promotion.coupon === "object" ? promo.promotion.coupon : null;
        codes.push({
          code: promo.code,
          active: promo.active,
          timesRedeemed: promo.times_redeemed,
          maxRedemptions: promo.max_redemptions,
          expiresAt: promo.expires_at ? new Date(promo.expires_at * 1000).toISOString().slice(0, 10) : null,
          discount: coupon
            ? coupon.percent_off != null
              ? `${coupon.percent_off}% off`
              : coupon.amount_off != null
                ? `$${(coupon.amount_off / 100).toFixed(2)} off`
                : "discount"
            : "unknown",
          duration: coupon
            ? coupon.duration === "repeating"
              ? `${coupon.duration_in_months ?? "?"} months`
              : coupon.duration
            : null,
        });
      }
      if (!page.has_more || page.data.length === 0) break;
      if (codes.length >= MAX_PROMO_CODES) {
        truncated = true;
        break;
      }
      startingAfter = page.data[page.data.length - 1]!.id;
    }
    codes.sort((a, b) => b.timesRedeemed - a.timesRedeemed || a.code.localeCompare(b.code));
    return { count: codes.length, complete: !truncated, codes };
  },
});
