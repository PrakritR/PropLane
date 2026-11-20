import { NextResponse } from "next/server";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { logPlaidFailure } from "@/lib/plaid/client.server";
import { getPlaidItemForOwner, toPlaidItemView } from "@/lib/plaid/items.server";
import { syncPlaidItem } from "@/lib/plaid/transactions-sync.server";

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
