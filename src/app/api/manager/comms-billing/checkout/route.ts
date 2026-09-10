import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { isCommsCreditPack } from "@/lib/comms-billing/credit-packs";
import { loadCommsWallet } from "@/lib/comms-billing/wallet.server";
import { createCommsCreditCheckout } from "@/lib/comms-billing/credit-purchase.server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isCommsPaygBillingEnabled())
    return NextResponse.json(
      {
        error:
          "Credit purchases are temporarily unavailable. Your existing balance is unchanged.",
      },
      { status: 503 },
    );
  const limit = await rateLimit(
    `comms-credit-checkout:${auth.userId}`,
    10,
    60_000,
  );
  if (limit.unavailable)
    return NextResponse.json(
      { error: "Purchases are temporarily unavailable." },
      { status: 503 },
    );
  if (!limit.ok)
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429 },
    );
  const body = await req.json().catch(() => null);
  if (
    !body ||
    !isCommsCreditPack(body.creditCents) ||
    typeof body.purchaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.purchaseId,
    ) ||
    Object.keys(body).some(
      (key) => !["creditCents", "purchaseId"].includes(key),
    )
  ) {
    return NextResponse.json(
      { error: "Choose an available credit amount." },
      { status: 400 },
    );
  }
  try {
    // This endpoint buys credit for the authenticated manager's OWN account.
    // A co-manager invitation is not permission to spend the owner's money.
    const wallet = await loadCommsWallet(auth.db, auth.userId);
    if (wallet.paused)
      return NextResponse.json(
        {
          error:
            "Communication billing is under review. Contact PropLane before buying credit.",
        },
        { status: 409 },
      );
    const checkout = await createCommsCreditCheckout(
      auth.db,
      auth.userId,
      body.purchaseId,
      body.creditCents,
      req,
    );
    return NextResponse.json(checkout, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Checkout could not be opened.",
      },
      { status: 503 },
    );
  }
}
