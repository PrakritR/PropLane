import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import { resolveStripePayoutContext, stripePayoutContextError } from "@/lib/auth/manager-stripe-payout-access.server";
import { clientIpFrom } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";
import { getIdentityRequirements, submitIdentity } from "@/lib/stripe-connect-identity.server";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

type ResolvedOwner =
  | { ok: true; userId: string; payoutOwnerUserId: string; service: ServiceClient }
  | { ok: false; status: number; error: string };

/**
 * Resident payouts always land in the property owner's Connect account
 * (`resolveStripePayoutContext`), so identity verification is scoped the same
 * way as the rest of Payouts settings.
 */
async function resolveOwner(): Promise<ResolvedOwner> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Unauthorized." };

  const service = createSupabaseServiceRoleClient();
  const payout = await resolveStripePayoutContext(service, user.id);
  if (!payout.payoutOwnerUserId) {
    return {
      ok: false,
      status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500,
      error: stripePayoutContextError(payout.unresolvedReason),
    };
  }
  return { ok: true, userId: user.id, payoutOwnerUserId: payout.payoutOwnerUserId, service };
}

/**
 * GET requirements/spec/status for the signed-in owner (or a co-manager with
 * at least read access to the owner's bank/payout settings — this response
 * carries field labels and due-status only, never a filled-in value).
 */
export async function GET() {
  try {
    const resolved = await resolveOwner();
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const { userId, payoutOwnerUserId, service } = resolved;

    const access = await assertCoManagerBankAccountAccess(service, userId, payoutOwnerUserId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    try {
      const stripe = getStripe();
      const { data: ownerProfile } = await service
        .from("profiles")
        .select("email")
        .eq("id", payoutOwnerUserId)
        .maybeSingle();
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payoutOwnerUserId,
        email: ownerProfile?.email ?? undefined,
        allowClearStale: false,
      });
      const requirements = await getIdentityRequirements(stripe, accountId);
      return NextResponse.json(requirements);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({
          demo: true,
          status: "needs_info",
          fields: [],
          fallbackToEmbedded: false,
          isApplicationCollected: true,
          currentlyDue: [],
          disabledReason: null,
          message: "Stripe is not configured on the server; cannot read identity requirements.",
        });
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_NEEDS_RELINK",
            needsRelink: true,
            error: "We couldn't reach your saved Stripe account. Reconnect to start over.",
          },
          { status: 409 },
        );
      }
      return stripePayoutErrorResponse("stripe/connect/identity GET", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/identity GET", e);
  }
}

type IdentityPostBody = {
  accountToken?: unknown;
  personToken?: unknown;
  personId?: unknown;
  fields?: unknown;
  documents?: unknown;
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeFields(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

function sanitizeDocuments(value: unknown): { front: string; back?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const front = stringField((value as { front?: unknown }).front);
  if (!front) return undefined;
  const back = stringField((value as { back?: unknown }).back);
  return back ? { front, back } : { front };
}

/**
 * POST a Verify-identity submission. Identity is personal to the account
 * owner (legal name, DOB, SSN) — unlike bank-account edits, a co-manager
 * grant never authorizes submitting it on someone else's behalf, so this
 * route requires the caller to BE the payout owner.
 */
export async function POST(req: Request) {
  try {
    const resolved = await resolveOwner();
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const { userId, payoutOwnerUserId, service } = resolved;

    if (userId !== payoutOwnerUserId) {
      return NextResponse.json(
        { error: "Only the account owner can submit identity verification." },
        { status: 403 },
      );
    }

    const body = (await req.json().catch(() => null)) as IdentityPostBody | null;
    const accountToken = stringField(body?.accountToken);
    const personToken = stringField(body?.personToken);
    const personId = stringField(body?.personId);
    const fields = sanitizeFields(body?.fields);
    const documentFileIds = sanitizeDocuments(body?.documents);

    if (!accountToken && !personToken && !fields && !documentFileIds) {
      return NextResponse.json({ error: "Nothing to submit." }, { status: 400 });
    }

    try {
      const stripe = getStripe();
      const { data: ownerProfile } = await service
        .from("profiles")
        .select("email")
        .eq("id", payoutOwnerUserId)
        .maybeSingle();
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payoutOwnerUserId,
        email: ownerProfile?.email ?? undefined,
        allowClearStale: false,
      });

      const result = await submitIdentity(stripe, accountId, {
        accountToken,
        personToken,
        personId,
        fields,
        documentFileIds,
        // Server-derived — never trusted from the request body — for the
        // Stripe Services Agreement audit trail (`tos_acceptance`).
        tosAcceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: clientIpFrom(req),
          userAgent: req.headers.get("user-agent") ?? "unknown",
        },
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ status: result.status, fallbackToEmbedded: result.fallbackToEmbedded });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
          { status: 503 },
        );
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_NEEDS_RELINK",
            needsRelink: true,
            error: "We couldn't reach your saved Stripe account. Reconnect to start over.",
          },
          { status: 409 },
        );
      }
      return stripePayoutErrorResponse("stripe/connect/identity POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/identity POST", e);
  }
}
