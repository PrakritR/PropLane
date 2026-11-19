import { NextResponse } from "next/server";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { getPlaidClient, isPlaidPurpose, plaidFailure } from "@/lib/plaid/client.server";
import { createPlaidItem, maskLastFour } from "@/lib/plaid/items.server";
import { exchangePublicToken } from "@/lib/plaid/exchange.server";
import { createBankAccount } from "@/lib/manager-bank-reconciliation.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Exchange a Link `public_token` on the server and store the item under the SESSION user.
 * The owner is never read from the body. Returns institution and last four only.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      publicToken?: unknown;
      public_token?: unknown;
      purpose?: unknown;
      bankAccountId?: unknown;
      accountId?: unknown;
    };
    const publicToken = typeof body.publicToken === "string" ? body.publicToken : typeof body.public_token === "string" ? body.public_token : "";
    if (!publicToken || !isPlaidPurpose(body.purpose)) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
    const actor = await authorizePlaidPurpose(body.purpose);
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });

    const result = await exchangePublicToken(
      { db: actor.db, client: getPlaidClient(), createItem: createPlaidItem, createBankAccount },
      {
        ownerUserId: actor.userId,
        purpose: body.purpose,
        publicToken,
        bankAccountId: typeof body.bankAccountId === "string" ? body.bankAccountId : null,
        preferredPlaidAccountId: typeof body.accountId === "string" ? body.accountId : null,
      },
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    return NextResponse.json(
      { item: { id: result.item.id, institutionName: result.item.institution_name, accountMask: maskLastFour(result.item.account_mask), accountName: result.item.account_name, bankAccountId: result.item.bank_account_id } },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.warn("[plaid] exchange failed", plaidFailure(error).code);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
