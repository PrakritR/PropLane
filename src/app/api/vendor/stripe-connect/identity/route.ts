import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { clientIpFrom } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureVendorConnectAccountId } from "@/lib/stripe-connect-account";
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";
import { getIdentityRequirements, submitIdentity } from "@/lib/stripe-connect-identity.server";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/connect/identity` — scoped to the vendor's own Connect account; there is no co-manager concept for a vendor. */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

    try {
      const stripe = getStripe();
      const db = createSupabaseServiceRoleClient();
      const accountId = await ensureVendorConnectAccountId(stripe, db, {
        userId: access.actor.userId,
        email: access.actor.email || undefined,
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
      return stripePayoutErrorResponse("vendor/stripe-connect/identity GET", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/identity GET", e);
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

export async function POST(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
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
      const db = createSupabaseServiceRoleClient();
      const accountId = await ensureVendorConnectAccountId(stripe, db, {
        userId: access.actor.userId,
        email: access.actor.email || undefined,
        allowClearStale: false,
      });

      const result = await submitIdentity(stripe, accountId, {
        accountToken,
        personToken,
        personId,
        fields,
        documentFileIds,
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
      return stripePayoutErrorResponse("vendor/stripe-connect/identity POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/identity POST", e);
  }
}
