import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import { resolveStripePayoutContext, stripePayoutContextError } from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import {
  isAllowedIdentityDocumentSize,
  isAllowedIdentityDocumentType,
  uploadIdentityDocumentFile,
} from "@/lib/stripe-connect-identity.server";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/**
 * Proxies a photo-ID upload straight to Stripe Files for the owner's Connect
 * account (`purpose: identity_document`) and returns only the resulting file
 * id — the bytes are never written to our database, storage, or logs.
 * Identity is personal to the account owner, same rule as the identity route
 * itself: a co-manager grant never authorizes uploading someone else's ID.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }
    if (user.id !== payout.payoutOwnerUserId) {
      return NextResponse.json({ error: "Only the account owner can upload identity documents." }, { status: 403 });
    }
    // Read access alone is never enough to upload — kept for symmetry with the
    // identity route's shape even though the owner check above already refuses
    // every co-manager.
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "multipart/form-data required." }, { status: 400 });
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required." }, { status: 400 });
    }
    if (!isAllowedIdentityDocumentType(file.type)) {
      return NextResponse.json({ error: "File must be a JPEG, PNG, or PDF." }, { status: 400 });
    }
    if (!isAllowedIdentityDocumentSize(file.size)) {
      return NextResponse.json({ error: "File must be smaller than 10 MB." }, { status: 400 });
    }

    try {
      const stripe = getStripe();
      const { data: ownerProfile } = await service
        .from("profiles")
        .select("email")
        .eq("id", payout.payoutOwnerUserId)
        .maybeSingle();
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payout.payoutOwnerUserId,
        email: ownerProfile?.email ?? undefined,
        allowClearStale: false,
      });
      const bytes = Buffer.from(await file.arrayBuffer());
      const fileId = await uploadIdentityDocumentFile(stripe, accountId, {
        data: bytes,
        name: file.name || "identity-document",
        type: file.type,
      });
      return NextResponse.json({ fileId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
          { status: 503 },
        );
      }
      return stripePayoutErrorResponse("stripe/connect/identity/document POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/identity/document POST", e);
  }
}
