import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureVendorConnectAccountId } from "@/lib/stripe-connect-account";
import {
  isAllowedIdentityDocumentSize,
  isAllowedIdentityDocumentType,
  uploadIdentityDocumentFile,
} from "@/lib/stripe-connect-identity.server";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/connect/identity/document` — scoped to the vendor's own Connect account. */
export async function POST(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

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
      const db = createSupabaseServiceRoleClient();
      const accountId = await ensureVendorConnectAccountId(stripe, db, {
        userId: access.actor.userId,
        email: access.actor.email || undefined,
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
      return stripePayoutErrorResponse("vendor/stripe-connect/identity/document POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/identity/document POST", e);
  }
}
