import { NextResponse } from "next/server";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import {
  createPromoCode,
  createPromoCodeSchema,
  getPromoCodeRecord,
  listPromoCodes,
  setPromoCodeActive,
  setPromoCodeActiveSchema,
} from "@/lib/admin/admin-promo-codes.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function failure(action: string, error: unknown) {
  if (error instanceof AdminInputError) return json({ error: error.message }, error.status);
  // A Stripe error names request ids and parameters: logged here, never returned.
  console.error(`${action} /api/admin/promo-codes failed`, error);
  return json({ error: "Stripe could not complete that. Try again." }, 502);
}

async function readBody(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

function invalid(error: { issues: Array<{ message: string }> }) {
  return json({ error: error.issues[0]?.message ?? "Invalid promo code." }, 400);
}

/** GET /api/admin/promo-codes — every code with usage, or `?id=promo_…` for one with its redemptions. */
export async function GET(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (id) {
      const parsed = setPromoCodeActiveSchema.shape.id.safeParse(id);
      if (!parsed.success) return json({ error: "Invalid promo code id." }, 400);
      const record = await getPromoCodeRecord(parsed.data);
      return record ? json({ code: record }) : json({ error: "Promo code not found." }, 404);
    }
    return json(await listPromoCodes());
  } catch (error) {
    return failure("GET", error);
  }
}

/** POST /api/admin/promo-codes — creates the Stripe coupon and promotion code. */
export async function POST(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = createPromoCodeSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error);
  try {
    return json({ code: await createPromoCode(parsed.data) }, 201);
  } catch (error) {
    return failure("POST", error);
  }
}

/** PATCH /api/admin/promo-codes — `{ id, active }`; `active` defaults to false (deactivate). */
export async function PATCH(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = setPromoCodeActiveSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error);
  try {
    return json({ code: await setPromoCodeActive(parsed.data.id, parsed.data.active) });
  } catch (error) {
    return failure("PATCH", error);
  }
}
