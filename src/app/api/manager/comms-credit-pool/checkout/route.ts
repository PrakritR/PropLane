import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { isValidCommsCreditAmountCents } from "@/lib/comms-billing/credit-packs";
import { loadCommsPoolSnapshot, createCommsCreditPoolCheckout } from "@/lib/comms-billing/pool.server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Both the operation id and a named workspace id are v4 (`gen_random_uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Add credit to the SIGNED-IN funder's own account pool (S27). `appliesTo` is
 * `"all"` (default — funds every workspace this funder can access) or the id
 * of one workspace to pin it to; the checkout amount is unconditionally the
 * caller's own, never a body-supplied workspace's owner.
 */
export async function POST(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isCommsPaygBillingEnabled()) {
    return NextResponse.json(
      { error: "Credit purchases are temporarily unavailable. Your existing balance is unchanged." },
      { status: 503 },
    );
  }
  const limit = await rateLimit(`comms-credit-pool-checkout:${auth.userId}`, 10, 60_000);
  if (limit.unavailable) return NextResponse.json({ error: "Purchases are temporarily unavailable." }, { status: 503 });
  if (!limit.ok) return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (
    !body ||
    !isValidCommsCreditAmountCents(body.creditCents) ||
    typeof body.purchaseId !== "string" ||
    !UUID.test(body.purchaseId) ||
    (body.appliesTo !== "all" && !(typeof body.appliesTo === "string" && UUID.test(body.appliesTo))) ||
    Object.keys(body).some((key) => !["creditCents", "purchaseId", "appliesTo"].includes(key))
  ) {
    return NextResponse.json({ error: "Enter a whole-dollar amount from $5 to $500." }, { status: 400 });
  }

  try {
    const snapshot = await loadCommsPoolSnapshot(auth.db, auth.userId);
    if (snapshot.paused) {
      return NextResponse.json(
        { error: "Communication billing is under review. Contact PropLane before buying credit." },
        { status: 409 },
      );
    }
    const checkout = await createCommsCreditPoolCheckout(
      auth.db,
      auth.userId,
      body.purchaseId,
      body.creditCents,
      body.appliesTo === "all" ? null : body.appliesTo,
      req,
    );
    return NextResponse.json(checkout, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Checkout could not be opened." },
      { status: 503 },
    );
  }
}
