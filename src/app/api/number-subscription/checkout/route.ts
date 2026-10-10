import { resolveAppOrigin } from "@/lib/app-url";
import { rateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { numberErrorResponse, numberJson, resolveNumberOwner } from "@/lib/number-subscription/access.server";
import { isNumberSubscriptionEnabled } from "@/lib/number-subscription/constants";
import { getNumberAvailability } from "@/lib/number-subscription/availability.server";
import { createNumberSubscriptionCheckout } from "@/lib/number-subscription/subscription.server";

export const runtime = "nodejs";

/**
 * Start the $5/month PropLane Number subscription for the signed-in vendor or resident. The owner is
 * the session's user, never the body; the body may only name which held role it is acting as and a
 * same-origin return path.
 */
export async function POST(req: Request) {
  if (!isNumberSubscriptionEnabled()) return numberJson({ ok: false, error: "Not found." }, 404);
  const body = (await req.json().catch(() => null)) as { role?: unknown; returnPath?: unknown } | null;
  const auth = await resolveNumberOwner(body?.role);
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  const limit = await rateLimit(`number-subscription-checkout:${auth.owner.userId}`, 10, 60_000);
  if (limit.unavailable) return numberJson({ ok: false, error: "Checkout is temporarily unavailable." }, 503);
  if (!limit.ok) return numberJson({ ok: false, error: "Too many attempts. Try again shortly." }, 429);
  try {
    const db = createSupabaseServiceRoleClient();
    // Never sell a number that cannot be delivered (runtime switch off, cap 0, Twilio unconfigured).
    // Existing subscribers are untouched: this only refuses a NEW checkout.
    const availability = await getNumberAvailability(db, auth.owner.role);
    if (!availability.available) {
      return numberJson(
        { ok: false, code: "not_available", error: "PropLane Number is not available yet. Try again later." },
        409,
      );
    }
    const { url } = await createNumberSubscriptionCheckout(db, getStripe(), {
      userId: auth.owner.userId,
      email: auth.owner.email,
      role: auth.owner.role,
      origin: resolveAppOrigin(req),
      returnPath: body?.returnPath,
    });
    return numberJson({ ok: true, url });
  } catch (error) {
    return numberErrorResponse(error);
  }
}
