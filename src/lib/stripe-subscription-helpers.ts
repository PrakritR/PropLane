import type Stripe from "stripe";

/** Subscription statuses that no longer grant paid access through Stripe billing. */
export function isStripeSubscriptionStatusBillable(status: string | undefined): boolean {
  return status !== "canceled" && status !== "incomplete_expired";
}

/** True when the stored subscription id still represents an active Stripe-billed plan. */
export async function stripeSubscriptionIsBillable(
  stripeSubscriptionId: string | null | undefined,
  retrieve: (id: string) => Promise<{ status?: string }> = async (id) => {
    const { getStripe } = await import("@/lib/stripe");
    return getStripe().subscriptions.retrieve(id);
  },
): Promise<boolean> {
  const sid = stripeSubscriptionId?.trim();
  if (!sid) return false;
  try {
    const sub = await retrieve(sid);
    return isStripeSubscriptionStatusBillable(sub.status);
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e ? String((e as { code?: string }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    const missing = code === "resource_missing" || msg.toLowerCase().includes("no such subscription");
    if (missing) return false;
    throw e;
  }
}

/** Stripe typings / API versions differ; read period end defensively. */
function stripeUnixSeconds(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function stripeSubscriptionPeriodEndSec(sub: unknown): number | null {
  if (!sub || typeof sub !== "object") return null;

  const direct = stripeUnixSeconds((sub as { current_period_end?: unknown }).current_period_end);
  if (direct) return direct;

  const itemEnd = stripeUnixSeconds(
    (sub as { items?: { data?: Array<{ current_period_end?: unknown }> } }).items?.data?.[0]?.current_period_end,
  );
  if (itemEnd) return itemEnd;

  return stripeUnixSeconds((sub as { current_period?: { end?: unknown } }).current_period?.end);
}

/** Invoice → subscription id across Stripe API shape differences. */
export function stripeInvoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const raw = (inv as unknown as { subscription?: unknown }).subscription;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id: unknown }).id === "string") {
    return String((raw as { id: string }).id).trim();
  }
  return null;
}

/** Invoice → the Stripe Price id of its first line item, across API shape differences. */
export function stripeInvoiceLinePriceId(inv: Stripe.Invoice): string | null {
  const price = (inv as unknown as { lines?: { data?: Array<{ price?: unknown }> } }).lines?.data?.[0]?.price;
  if (typeof price === "string" && price.trim()) return price.trim();
  if (price && typeof price === "object" && "id" in price && typeof (price as { id: unknown }).id === "string") {
    return String((price as { id: string }).id).trim();
  }
  return null;
}
