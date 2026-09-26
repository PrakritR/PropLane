import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import {
  ensureWorkspaceBalanceAccountId,
  readBalancePaidThisMonthCents,
  readBalanceSnapshot,
} from "@/lib/proplane-balance/ledger.server";

export const runtime = "nodejs";

/** Manager's PropLane balance (night/vendor-pay). `{ enabled: false }` whenever the flag is off — no account is ever created or read in that case. */
export async function GET() {
  try {
    if (!proplaneBalanceEnabled()) {
      return NextResponse.json({ enabled: false, availableCents: 0, pendingCents: 0, paidThisMonthCents: 0, currency: "usd" });
    }
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const accountId = await ensureWorkspaceBalanceAccountId(auth.db, auth.userId);
    const [snapshot, paidThisMonthCents] = await Promise.all([
      readBalanceSnapshot(auth.db, accountId),
      readBalancePaidThisMonthCents(auth.db, accountId),
    ]);
    return NextResponse.json({ enabled: true, ...snapshot, paidThisMonthCents });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not read the PropLane balance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
