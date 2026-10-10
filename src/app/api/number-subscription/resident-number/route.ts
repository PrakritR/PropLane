import { rateLimit } from "@/lib/rate-limit";
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
import {
  getResidentAgentNumberStatus,
  provisionResidentAgentNumber,
} from "@/lib/resident-agent-number/number.server";
import { loadVendorVerifiedPhone } from "@/lib/vendor-work-identity.server";

export const runtime = "nodejs";

async function residentSnapshot(userId: string) {
  const db = createSupabaseServiceRoleClient();
  const [subscription, credit, number, phone, availability] = await Promise.all([
    getNumberSubscription(userId, db),
    getNumberCreditBalance(userId, db),
    getResidentAgentNumberStatus(db, userId),
    loadVendorVerifiedPhone(db, userId),
    getNumberAvailability(db, "resident"),
  ]);
  return {
    enabled: isNumberSubscriptionEnabled(),
    available: availability.available,
    priceCents: NUMBER_SUBSCRIPTION_PRICE_CENTS,
    includedMonthlyCents: NUMBER_INCLUDED_CREDIT_CENTS,
    subscription: toPublicNumberSubscription(subscription),
    credit,
    number,
    phoneVerified: phone.verified,
  };
}

/** The signed-in resident's OWN PropLane agent: subscription, credit, number. Never takes an id. */
export async function GET() {
  const auth = await resolveNumberOwner("resident");
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  // Hidden, not broken, while the flag is off: no queries, nothing to render.
  if (!isNumberSubscriptionEnabled()) return numberJson({ ok: true, enabled: false });
  try {
    return numberJson({ ok: true, ...(await residentSnapshot(auth.owner.userId)) });
  } catch (error) {
    return numberErrorResponse(error);
  }
}

/** Get (or retry getting) the subscribed resident's number. Idempotent: it can never buy a second one. */
export async function POST() {
  if (!isNumberSubscriptionEnabled()) return numberJson({ ok: false, error: "Not found." }, 404);
  const auth = await resolveNumberOwner("resident");
  if (!auth.ok) return numberJson({ ok: false, error: auth.error }, auth.status);
  const limit = await rateLimit(`resident-agent-number:${auth.owner.userId}`, 6, 60_000);
  if (limit.unavailable) return numberJson({ ok: false, error: "This is temporarily unavailable." }, 503);
  if (!limit.ok) return numberJson({ ok: false, error: "Too many attempts. Try again shortly." }, 429);
  try {
    const db = createSupabaseServiceRoleClient();
    const result = await provisionResidentAgentNumber(db, auth.owner.userId, { requireFlag: true });
    return numberJson({ ok: true, provision: result, ...(await residentSnapshot(auth.owner.userId)) });
  } catch (error) {
    return numberErrorResponse(error);
  }
}
