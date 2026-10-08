import { resolveAppOrigin } from "@/lib/app-url";
import { rateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { numberErrorResponse, numberJson, resolveNumberOwner } from "@/lib/number-subscription/access.server";
import { createNumberBillingPortal } from "@/lib/number-subscription/subscription.server";

export const runtime = "nodejs";

/** Stripe billing portal (cancel, update card, invoices) for the caller's OWN customer only. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { role?: unknown; returnPath?: unknown } | null;
  const auth = await resolveNumberOwner(body?.role);
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  const limit = await rateLimit(`number-subscription-portal:${auth.owner.userId}`, 10, 60_000);
  if (limit.unavailable) return numberJson({ ok: false, error: "Billing is temporarily unavailable." }, 503);
  if (!limit.ok) return numberJson({ ok: false, error: "Too many attempts. Try again shortly." }, 429);
  try {
    const { url } = await createNumberBillingPortal(createSupabaseServiceRoleClient(), getStripe(), {
      userId: auth.owner.userId,
      role: auth.owner.role,
      origin: resolveAppOrigin(req),
      returnPath: body?.returnPath,
    });
    return numberJson({ ok: true, url });
  } catch (error) {
    return numberErrorResponse(error);
  }
}
