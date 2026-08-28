import { clearManagerPricingOffer, persistManagerPricingOffer, readManagerPricingOffer, type ManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";
import { waitForAuthUser } from "@/lib/auth/wait-for-auth-user";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { PlanTierId } from "@/data/manager-plan-tiers";

export type PartnerPricingSession = {
  authenticated: boolean;
  needsPricing: boolean;
  email?: string;
  fullName?: string | null;
  isGoogle?: boolean;
};

export type ContinuePartnerPricingResult =
  | { status: "checkout"; clientSecret: string }
  | { status: "finish"; sessionId: string }
  | { status: "portal"; redirectTo: string }
  | { status: "provisioned" }
  | { status: "error"; message: string };

export async function fetchPartnerPricingSession(): Promise<PartnerPricingSession> {
  try {
    const res = await fetch("/api/auth/manager-onboarding-status", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return { authenticated: false, needsPricing: false };
    return (await res.json()) as PartnerPricingSession;
  } catch {
    return { authenticated: false, needsPricing: false };
  }
}

export async function ensurePartnerPricingFreeAccount(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const supabase = createSupabaseBrowserClient();
    const user = await waitForAuthUser(supabase);
    if (!user) {
      return { ok: false, error: "Your session isn't ready yet — try again in a moment." };
    }

    const res = await fetch("/api/auth/provision-pending-manager", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trial: false }),
    });
    const body = (await res.json()) as { error?: string; skipped?: boolean };
    if (!res.ok) {
      if (res.status === 409 && body.skipped) {
        return { ok: true };
      }
      const message = body.error ?? "Could not create your account.";
      if (res.status === 409 && message.toLowerCase().includes("already exists")) {
        return { ok: true };
      }
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error while creating your account." };
  }
}

function offerToRequestBody(offer: ManagerPricingOffer, extras?: { phone?: string }) {
  return {
    tier: offer.tier,
    billing: offer.billing,
    promo: offer.promo,
    phone: extras?.phone,
    trialSignup: offer.trialSignup === true ? true : undefined,
  };
}

export async function continuePartnerPricingWithOffer(
  offer: ManagerPricingOffer,
  extras?: { phone?: string },
): Promise<ContinuePartnerPricingResult> {
  persistManagerPricingOffer(offer);

  const supabase = createSupabaseBrowserClient();
  const user = await waitForAuthUser(supabase);
  if (!user) {
    return { status: "error", message: "Your session isn't ready yet — try again in a moment." };
  }

  const session = await fetchPartnerPricingSession();
  const isPaidUpgrade = offer.tier !== "free" && session.authenticated && !session.needsPricing && !offer.trialSignup;

  if (session.authenticated && !session.needsPricing && offer.tier === "free") {
    clearManagerPricingOffer();
    return { status: "portal", redirectTo: "/portal/dashboard" };
  }

  // Only the FREE tier may be finalized up-front. For a paid signup we must NOT provision a
  // completed free manager here — that would grant portal access before the payment method is
  // added. pricing-oauth-continue provisions a PENDING account and returns the Stripe checkout;
  // the account is completed only once payment succeeds. Trial signup skips Stripe entirely.
  if (session.authenticated && session.needsPricing && offer.tier === "free" && !offer.trialSignup) {
    const provision = await ensurePartnerPricingFreeAccount();
    if (!provision.ok) {
      return { status: "error", message: provision.error };
    }
  }

  if (isPaidUpgrade) {
    const ensureFree = await ensurePartnerPricingFreeAccount();
    if (!ensureFree.ok) {
      return { status: "error", message: ensureFree.error };
    }
  }

  const res = await fetch("/api/manager/pricing-oauth-continue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(offerToRequestBody(offer, extras)),
  });

  const body = (await res.json()) as {
    action?: string;
    sessionId?: string;
    clientSecret?: string;
    redirectTo?: string;
    error?: string;
  };

  if (!res.ok) {
    return { status: "error", message: body.error ?? "Could not continue signup." };
  }

  if (body.action === "finish" && body.sessionId) {
    clearManagerPricingOffer();
    return { status: "finish", sessionId: body.sessionId };
  }

  if (body.action === "portal") {
    clearManagerPricingOffer();
    return {
      status: "portal",
      redirectTo: body.redirectTo?.startsWith("/") ? body.redirectTo : "/portal/dashboard",
    };
  }

  if (body.action === "checkout" && body.clientSecret) {
    return { status: "checkout", clientSecret: body.clientSecret };
  }

  return { status: "error", message: "Unexpected signup response." };
}

export function buildPricingOffer(opts: {
  tier: PlanTierId;
  billing: "monthly" | "annual";
  promo?: string;
  returnSurface?: "mobile-plan" | "partner-pricing";
  trialSignup?: boolean;
}): ManagerPricingOffer {
  const stored = readManagerPricingOffer();
  return {
    tier: opts.tier,
    billing: opts.billing,
    promo: opts.promo ?? stored?.promo,
    returnSurface: opts.returnSurface ?? stored?.returnSurface,
    trialSignup: opts.trialSignup ?? stored?.trialSignup,
  };
}

export async function handleGoogleSignedInReturn(
  offer?: ManagerPricingOffer,
): Promise<{ status: "provisioned" } | { status: "error"; message: string }> {
  if (offer?.trialSignup) {
    if (offer.tier === "free") {
      const provision = await ensurePartnerPricingFreeAccount();
      if (!provision.ok) {
        return { status: "error", message: provision.error };
      }
    }
    if (typeof window !== "undefined") {
      const params = new URLSearchParams({
        mode: "create",
        role: "manager",
        google_signed_in: "1",
        tier: offer.tier,
        billing: offer.billing,
      });
      window.history.replaceState({}, "", `/auth/create-account?${params}`);
    }
    return { status: "provisioned" };
  }

  if (!offer || offer.tier === "free") {
    const provision = await ensurePartnerPricingFreeAccount();
    if (!provision.ok) {
      return { status: "error", message: provision.error };
    }
  }

  if (typeof window !== "undefined") {
    const stored = readManagerPricingOffer();
    const onMobilePlan =
      offer?.returnSurface === "mobile-plan" ||
      stored?.returnSurface === "mobile-plan" ||
      window.location.pathname.startsWith("/auth/manager/plan");
    if (onMobilePlan) {
      window.history.replaceState({}, "", "/auth/manager/plan");
    } else {
      const params = new URLSearchParams(window.location.search);
      const upgrade = params.get("upgrade") === "1";
      const nextUrl = upgrade ? "/partner/pricing?upgrade=1" : "/partner/pricing";
      window.history.replaceState({}, "", nextUrl);
    }
  }

  return { status: "provisioned" };
}
