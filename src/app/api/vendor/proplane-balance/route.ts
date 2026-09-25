import { NextResponse } from "next/server";
import { assertVendorFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { ensureVendorBalanceAccountId, readBalanceSnapshot } from "@/lib/proplane-balance/ledger.server";

export const runtime = "nodejs";

/** Vendor's PropLane balance (night/vendor-pay). `{ enabled: false }` whenever the flag is off. */
export async function GET() {
  try {
    if (!proplaneBalanceEnabled()) {
      return NextResponse.json({ enabled: false, availableCents: 0, pendingCents: 0, currency: "usd" });
    }
    const auth = await getReportsAuthContext({ preferRole: "vendor" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertVendorFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const accountId = await ensureVendorBalanceAccountId(auth.db, auth.userId);
    const snapshot = await readBalanceSnapshot(auth.db, accountId);
    return NextResponse.json({ enabled: true, ...snapshot });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not read the PropLane balance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
