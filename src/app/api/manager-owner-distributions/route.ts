import { NextResponse } from "next/server";
import { assertManagerFinancialsCoManagerAccess } from "@/lib/auth/co-manager-access";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { createOwnerDistribution, listOwnerDistributions } from "@/lib/manager-owner-distributions.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const distributions = await listOwnerDistributions(auth.db, auth.userId, {
      propertyId: url.searchParams.get("propertyId")?.trim() || undefined,
      status: url.searchParams.get("status")?.trim() || undefined,
    });
    return NextResponse.json({ distributions });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to list distributions." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      propertyId?: string;
      ownerId?: string;
      periodStart?: string;
      periodEnd?: string;
      beginningBalanceCents?: number;
      cashInCents?: number;
      cashOutCents?: number;
      managementFeeCents?: number;
      reserveHoldbackCents?: number;
      adjustmentsCents?: number;
      memo?: string;
    };

    const propertyId = String(body.propertyId ?? "").trim();
    // Writing an owner distribution is a financials write — this used to
    // check only the plan tier above, so the workspace's `propertyIds` list
    // (populated by ANY accepted co-manager membership, regardless of which
    // module was granted) was the only property gate. A co-manager granted a
    // module other than financials (e.g. Maintenance) on an owner's house
    // could post a distribution for it. ownerManagerUserId is intentionally
    // undefined — passing the caller would short-circuit the check
    // (owner===caller => allow) and make it a no-op; undefined runs the real
    // per-property permission check, which already fast-paths true when the
    // caller owns the property.
    const cm = await assertManagerFinancialsCoManagerAccess(auth.db, auth.userId, propertyId, undefined, "edit");
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const distribution = await createOwnerDistribution(auth.db, {
      managerUserId: auth.userId,
      propertyId,
      ownerId: body.ownerId || null,
      periodStart: String(body.periodStart ?? ""),
      periodEnd: String(body.periodEnd ?? ""),
      beginningBalanceCents: body.beginningBalanceCents,
      cashInCents: body.cashInCents,
      cashOutCents: body.cashOutCents,
      managementFeeCents: body.managementFeeCents,
      reserveHoldbackCents: body.reserveHoldbackCents,
      adjustmentsCents: body.adjustmentsCents,
      memo: body.memo,
    });
    track("owner_distribution_created", auth.userId, {
      distributionId: distribution.id,
      amountCents: distribution.distributionCents,
    });
    return NextResponse.json({ distribution });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create distribution." }, { status: 500 });
  }
}
