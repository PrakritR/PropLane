import { NextResponse } from "next/server";
import {
  assertManagerFinancialsAccess,
  getReportsAuthContext,
} from "@/lib/reports/auth";
import {
  disposeSecurityDeposit,
  type SecurityDepositDispositionType,
} from "@/lib/reports/security-deposits";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

type DisposeBody = {
  dispositionType: SecurityDepositDispositionType;
  refundCents: number;
  withholdCents: number;
  itemization?: { label: string; amountCents: number }[];
  dispositionDate?: string;
  memo?: string;
  offlineReturn?: { method: "cash" | "check" | "bank_transfer" | "other"; reference: string };
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { id } = await ctx.params;
    const body = (await req.json()) as DisposeBody;

    if (!body.dispositionType) {
      return NextResponse.json({ error: "dispositionType is required." }, { status: 400 });
    }

    const deposit = await disposeSecurityDeposit(auth.db, {
      managerUserId: auth.userId,
      depositId: id,
      dispositionType: body.dispositionType,
      refundCents: Number(body.refundCents) || 0,
      withholdCents: Number(body.withholdCents) || 0,
      itemization: body.itemization,
      dispositionDate: body.dispositionDate,
      memo: body.memo,
      offlineReturn: body.offlineReturn,
    });

    track("security_deposit_disposed", auth.userId, {
      depositId: deposit.id,
      dispositionType: body.dispositionType,
      refundCents: Number(body.refundCents) || 0,
      withholdCents: Number(body.withholdCents) || 0,
    });

    return NextResponse.json({ ok: true, deposit });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Disposition failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
