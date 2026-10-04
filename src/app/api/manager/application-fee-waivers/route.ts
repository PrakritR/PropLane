import { NextResponse } from "next/server";
import {
  assertPropertiesOwnedByManager,
  type CreateWaiverCodeInput,
  createApplicationFeeWaiverCode,
  listApplicationFeeWaiverCodes,
  listApplicationFeeWaiverRedemptions,
} from "@/lib/application-fee-waiver";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/** GET — list this manager's OWN waiver codes and redemption history. Never another manager's. */
export async function GET() {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const [codes, redemptions] = await Promise.all([
      listApplicationFeeWaiverCodes(ctx.db, ctx.userId),
      listApplicationFeeWaiverRedemptions(ctx.db, ctx.userId),
    ]);
    return NextResponse.json({ codes, redemptions });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load waiver codes.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type CreateBody = {
  code?: string;
  label?: string;
  maxUses?: number | null;
  expiresAt?: string | null;
  /** application (default) | lease | both. */
  appliesTo?: string | null;
  /** Limit the code to these properties; omitted/empty = every property. */
  propertyIds?: string[] | null;
};

/** POST — create a new waiver code owned by the signed-in manager. */
export async function POST(req: Request) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as CreateBody;
  if (Array.isArray(body.propertyIds) && body.propertyIds.length > 0) {
    const owned = await assertPropertiesOwnedByManager(ctx.db, ctx.userId, body.propertyIds.map(String));
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: 400 });
  }
  const result = await createApplicationFeeWaiverCode(ctx.db, ctx.userId, {
    code: body.code,
    label: body.label,
    maxUses: body.maxUses ?? null,
    expiresAt: body.expiresAt ?? null,
    appliesTo: (body.appliesTo ?? null) as CreateWaiverCodeInput["appliesTo"],
    propertyIds: body.propertyIds ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ code: result.code });
}
