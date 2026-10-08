import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { numberErrorResponse, numberJson, resolveNumberOwner } from "@/lib/number-subscription/access.server";
import {
  isNumberSubscriptionEnabled,
  NUMBER_INCLUDED_CREDIT_CENTS,
  NUMBER_SUBSCRIPTION_PRICE_CENTS,
} from "@/lib/number-subscription/constants";
import { getNumberCreditBalance } from "@/lib/number-subscription/credit.server";
import { getNumberAvailability } from "@/lib/number-subscription/availability.server";
import { getNumberSubscription, toPublicNumberSubscription } from "@/lib/number-subscription/subscription.server";

export const runtime = "nodejs";

/** The caller's OWN subscription status and credit balance. Never takes an id. */
export async function GET(req: Request) {
  const role = new URL(req.url).searchParams.get("role");
  const auth = await resolveNumberOwner(role);
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  try {
    const db = createSupabaseServiceRoleClient();
    const [subscription, credit, availability] = await Promise.all([
      getNumberSubscription(auth.owner.userId, db),
      getNumberCreditBalance(auth.owner.userId, db),
      getNumberAvailability(db, auth.owner.role),
    ]);
    return numberJson({
      ok: true,
      enabled: isNumberSubscriptionEnabled(),
      /** Whether a NEW subscriber's number can be provisioned right now (see availability.server.ts). */
      available: availability.available,
      priceCents: NUMBER_SUBSCRIPTION_PRICE_CENTS,
      includedMonthlyCents: NUMBER_INCLUDED_CREDIT_CENTS,
      role: auth.owner.role,
      subscription: toPublicNumberSubscription(subscription),
      credit,
    });
  } catch (error) {
    return numberErrorResponse(error);
  }
}
