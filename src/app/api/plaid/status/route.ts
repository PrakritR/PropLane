import { NextResponse } from "next/server";
import { plaidEnabled, isPlaidPurpose } from "@/lib/plaid/client.server";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { listPlaidItemsForOwner, toPlaidItemView } from "@/lib/plaid/items.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Tells the client whether to draw any Plaid control, plus the viewer's own connections (no tokens). */
export async function GET(req: Request) {
  if (!plaidEnabled()) return NextResponse.json({ enabled: false, items: [] }, { headers: NO_STORE });
  const purpose = new URL(req.url).searchParams.get("purpose");
  if (!isPlaidPurpose(purpose)) return NextResponse.json({ enabled: false, items: [] }, { headers: NO_STORE });
  const actor = await authorizePlaidPurpose(purpose);
  if (!actor.ok) return NextResponse.json({ enabled: false, items: [] }, { headers: NO_STORE });
  try {
    const rows = await listPlaidItemsForOwner(actor.db, actor.userId, purpose);
    return NextResponse.json({ enabled: true, items: rows.map(toPlaidItemView) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ enabled: true, items: [] }, { headers: NO_STORE });
  }
}
