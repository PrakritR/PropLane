import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { getPlaidClient, isPlaidPurpose, plaidFailure } from "@/lib/plaid/client.server";
import { getPlaidItemForOwner, readPlaidAccessToken } from "@/lib/plaid/items.server";
import { plaidWebhookUrl } from "@/lib/plaid/webhook-url";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Mint a Link token for the SESSION user and one purpose. `itemId` (our row id, never Plaid's)
 * opens update mode for a connection that needs a re-login. Only the link token is returned.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { purpose?: unknown; itemId?: unknown };
    if (!isPlaidPurpose(body.purpose)) return NextResponse.json({ error: "Unknown purpose." }, { status: 400, headers: NO_STORE });
    const actor = await authorizePlaidPurpose(body.purpose);
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });

    let accessToken: string | undefined;
    if (typeof body.itemId === "string" && body.itemId) {
      const item = await getPlaidItemForOwner(actor.db, actor.userId, body.itemId);
      if (!item || item.purpose !== body.purpose) return NextResponse.json({ error: "Connection not found." }, { status: 404, headers: NO_STORE });
      accessToken = readPlaidAccessToken(item);
    }

    const res = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: actor.userId },
      client_name: "PropLane",
      language: "en",
      country_codes: [CountryCode.Us],
      // Update mode names the existing item and carries no products.
      ...(accessToken ? { access_token: accessToken } : { products: [Products.Transactions] }),
      webhook: plaidWebhookUrl(req),
    });
    return NextResponse.json({ linkToken: res.data.link_token }, { headers: NO_STORE });
  } catch (error) {
    console.warn("[plaid] link token failed", plaidFailure(error).code);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
