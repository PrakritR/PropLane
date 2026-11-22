import { NextResponse } from "next/server";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { logPlaidFailure } from "@/lib/plaid/client.server";
import { getPlaidItemForOwner, toPlaidItemView } from "@/lib/plaid/items.server";
import { syncPlaidItem } from "@/lib/plaid/transactions-sync.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/** Manager-triggered sync (Retry / after a reconnect) of one of their own connections. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { itemId?: unknown };
    const actor = await authorizePlaidPurpose("bank_feed");
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });
    if (typeof body.itemId !== "string" || !body.itemId) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
    // `claimPlaidSync` already makes a repeat call cheap (it answers `busy`), but the claim is a write
    // and the walk behind it is an outbound Plaid call: Retry stays bounded like every other Plaid route.
    const limit = await rateLimit(`plaid-sync:${actor.userId}:${clientIpFrom(req)}`, 20, 10 * 60_000);
    if (!limit.ok) return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429, headers: NO_STORE });
    const item = await getPlaidItemForOwner(actor.db, actor.userId, body.itemId);
    if (!item || item.purpose !== "bank_feed") return NextResponse.json({ error: "Connection not found." }, { status: 404, headers: NO_STORE });
    const result = await syncPlaidItem(actor.db, item);
    const fresh = await getPlaidItemForOwner(actor.db, actor.userId, body.itemId);
    return NextResponse.json({ result, item: fresh ? toPlaidItemView(fresh) : null }, { headers: NO_STORE });
  } catch (error) {
    logPlaidFailure("[plaid] manager sync failed", error);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
