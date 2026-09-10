import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  ensureManagerBillingCustomer,
  listManagerBillingCards,
  setManagerDefaultBillingCard,
} from "@/lib/manager-stripe-customer.server";
import { getStripe } from "@/lib/stripe";
import { resolveAppOrigin } from "@/lib/app-url";
import { rateLimit } from "@/lib/rate-limit";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store" };
const failure = (error: unknown) =>
  NextResponse.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Card management is unavailable. Try again.",
    },
    { status: 503, headers: noStore },
  );
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json(
      await listManagerBillingCards(auth.db, auth.userId),
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.operationId,
    ) ||
    Object.keys(body).some((key) => key !== "operationId")
  )
    return NextResponse.json(
      { error: "Invalid card setup request." },
      { status: 400 },
    );
  const limit = await rateLimit(`manager-card-setup:${auth.userId}`, 10, 60000);
  if (limit.unavailable || !limit.ok)
    return NextResponse.json(
      { error: "Please try card setup again shortly." },
      { status: limit.unavailable ? 503 : 429 },
    );
  try {
    const customer = await ensureManagerBillingCustomer(auth.db, auth.userId);
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "setup",
        ui_mode: "embedded_page",
        customer,
        payment_method_types: ["card"],
        currency: "usd",
        client_reference_id: auth.userId,
        metadata: {
          purpose: "manager_card_setup",
          manager_user_id: auth.userId,
        },
        setup_intent_data: {
          metadata: {
            purpose: "manager_card_setup",
            manager_user_id: auth.userId,
          },
        },
        return_url: `${resolveAppOrigin(req)}/portal/profile?tab=billing&card_setup={CHECKOUT_SESSION_ID}`,
      },
      {
        idempotencyKey: `manager-card-setup:${auth.userId}:${body.operationId}`,
      },
    );
    if (!session.client_secret)
      throw new Error("Card setup could not be opened.");
    return NextResponse.json(
      { clientSecret: session.client_secret },
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(req: Request) {
  const auth = await requireManagerRouteUser();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.paymentMethodId !== "string" ||
    !/^pm_[A-Za-z0-9]+$/.test(body.paymentMethodId) ||
    Object.keys(body).some((key) => key !== "paymentMethodId")
  )
    return NextResponse.json(
      { error: "Choose a saved card." },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await setManagerDefaultBillingCard(
        auth.db,
        auth.userId,
        body.paymentMethodId,
      ),
      { headers: noStore },
    );
  } catch (error) {
    return failure(error);
  }
}
