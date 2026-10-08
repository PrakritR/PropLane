import { resolveAppOrigin } from "@/lib/app-url";
import { isValidCommsCreditAmountCents } from "@/lib/comms-billing/credit-packs";
import { rateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { numberErrorResponse, numberJson, resolveNumberOwner } from "@/lib/number-subscription/access.server";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { createNumberCreditCheckout } from "@/lib/number-subscription/credit.server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Buy message credit for the signed-in number owner: one-time, $5-$500 whole dollars, never
 * auto-recharged. The owner is the session user; the body supplies only the amount and an operation id.
 */
export async function POST(req: Request) {
  if (!isNumberSubscriptionEnabled()) return numberJson({ ok: false, error: "Not found." }, 404);
  const body = (await req.json().catch(() => null)) as {
    creditCents?: unknown;
    purchaseId?: unknown;
    role?: unknown;
    returnPath?: unknown;
  } | null;
  const auth = await resolveNumberOwner(body?.role);
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  if (!body || !isValidCommsCreditAmountCents(body.creditCents) || typeof body.purchaseId !== "string" || !UUID.test(body.purchaseId)) {
    return numberJson({ ok: false, error: "Enter a whole-dollar amount from $5 to $500." }, 400);
  }
  const limit = await rateLimit(`number-credit-checkout:${auth.owner.userId}`, 10, 60_000);
  if (limit.unavailable) return numberJson({ ok: false, error: "Purchases are temporarily unavailable." }, 503);
  if (!limit.ok) return numberJson({ ok: false, error: "Too many attempts. Try again shortly." }, 429);
  try {
    const { url, purchaseId } = await createNumberCreditCheckout(createSupabaseServiceRoleClient(), getStripe(), {
      userId: auth.owner.userId,
      email: auth.owner.email,
      role: auth.owner.role,
      purchaseId: body.purchaseId,
      creditCents: body.creditCents,
      origin: resolveAppOrigin(req),
      returnPath: body.returnPath,
    });
    return numberJson({ ok: true, url, purchaseId });
  } catch (error) {
    return numberErrorResponse(error);
  }
}
