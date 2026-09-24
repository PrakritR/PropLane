import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { isValidCommsCreditAmountCents } from "@/lib/comms-billing/credit-packs";
import { loadCommsWallet } from "@/lib/comms-billing/wallet.server";
import { createCommsCreditCheckout } from "@/lib/comms-billing/credit-purchase.server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Both the operation id and every workspace id are v4 (`gen_random_uuid`). */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    !isValidCommsCreditAmountCents(body.creditCents) ||
    typeof body.purchaseId !== "string" ||
    !UUID.test(body.purchaseId) ||
    typeof body.workspaceId !== "string" ||
    !UUID.test(body.workspaceId) ||
    Object.keys(body).some(
      (key) => !["creditCents", "purchaseId", "workspaceId"].includes(key),
    )
  ) {
    return NextResponse.json(
      { error: "Enter a whole-dollar amount from $5 to $500." },
      { status: 400 },
    );
  }
  try {
    // Credit is per workspace, and only the workspace's OWNER may buy it. A
    // co-manager invitation is not permission to spend the owner's money, and
    // a workspace id in the body is not authorization: re-derive ownership.
    const { data: workspace, error: workspaceError } = await auth.db
      .from("portal_workspaces")
      .select("id")
      .eq("id", body.workspaceId)
      .eq("owner_user_id", auth.userId)
      .maybeSingle();
    if (workspaceError)
      return NextResponse.json(
        { error: "We could not verify that workspace. Try again." },
        { status: 503 },
      );
    if (!workspace)
      return NextResponse.json(
        { error: "Only the workspace owner can buy communication credit." },
        { status: 403 },
      );
    const wallet = await loadCommsWallet(auth.db, auth.userId, body.workspaceId);
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
      body.workspaceId,
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
