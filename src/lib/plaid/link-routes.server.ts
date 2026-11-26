import "server-only";

import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { getPlaidClient, isPlaidPurpose, logPlaidFailure, type PlaidPurpose } from "@/lib/plaid/client.server";
import { createPlaidItem, getPlaidItemForOwner, maskLastFour, readPlaidAccessToken } from "@/lib/plaid/items.server";
import { exchangePublicToken } from "@/lib/plaid/exchange.server";
import { plaidWebhookUrl } from "@/lib/plaid/webhook-url";
import { createBankAccount } from "@/lib/manager-bank-reconciliation.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

/**
 * The Link token / exchange pair, shared by the generic `/api/plaid/*` routes and the purpose-pinned
 * ones mounted elsewhere.
 *
 * Why a purpose may be pinned to a path: the managed read-only lock
 * (`MANAGED_READ_ONLY_ALLOWED_PATHS`) is a pure PATH policy, so one path serving several purposes
 * cannot be allowed for the resident's own bank pay while still refusing a manager's bank-feed
 * connect. `only` makes the path's purpose explicit — a body that names another purpose is refused
 * before any gate, so an allowlisted path can never reach a purpose it was not opened for.
 */
export type PlaidRouteOptions = { only?: PlaidPurpose };

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The same ceiling the income routes carry. Link token minting and the exchange are each an outbound
 * Plaid call per request, so an authenticated caller is still a caller: ten per ten minutes per user
 * and IP. A refusal that cannot be counted (`unavailable`) is a refusal.
 */
const PLAID_LINK_LIMIT = { max: 10, windowMs: 10 * 60_000 };

async function withinLinkLimit(req: Request, scope: string, userId: string): Promise<boolean> {
  const limit = await rateLimit(`plaid-${scope}:${userId}:${clientIpFrom(req)}`, PLAID_LINK_LIMIT.max, PLAID_LINK_LIMIT.windowMs);
  return limit.ok;
}

function readPurpose(value: unknown, options: PlaidRouteOptions): PlaidPurpose | null {
  if (!isPlaidPurpose(value)) return null;
  if (options.only && value !== options.only) return null;
  return value;
}

/**
 * Mint a Link token for the SESSION user and one purpose. `itemId` (our row id, never Plaid's)
 * opens update mode for a connection that needs a re-login. Only the link token is returned.
 */
export async function plaidLinkTokenRoute(req: Request, options: PlaidRouteOptions = {}): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { purpose?: unknown; itemId?: unknown };
    const purpose = readPurpose(body.purpose, options);
    if (!purpose) return NextResponse.json({ error: "Unknown purpose." }, { status: 400, headers: NO_STORE });
    const actor = await authorizePlaidPurpose(purpose);
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });
    if (!(await withinLinkLimit(req, "link-token", actor.userId))) {
      return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429, headers: NO_STORE });
    }

    let accessToken: string | undefined;
    if (typeof body.itemId === "string" && body.itemId) {
      const item = await getPlaidItemForOwner(actor.db, actor.userId, body.itemId);
      if (!item || item.purpose !== purpose) return NextResponse.json({ error: "Connection not found." }, { status: 404, headers: NO_STORE });
      accessToken = readPlaidAccessToken(item);
    }

    const res = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: actor.userId },
      client_name: "PropLane",
      language: "en",
      country_codes: [CountryCode.Us],
      // Update mode names the existing item and carries no products.
      ...(accessToken ? { access_token: accessToken } : { products: purpose === "resident_pay" ? [Products.Auth] : [Products.Transactions] }),
      webhook: plaidWebhookUrl(req),
    });
    return NextResponse.json({ linkToken: res.data.link_token }, { headers: NO_STORE });
  } catch (error) {
    logPlaidFailure("[plaid] link token failed", error);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}

/**
 * Exchange a Link `public_token` on the server and store the item under the SESSION user.
 * The owner is never read from the body. Returns institution and last four only.
 */
export async function plaidExchangeRoute(req: Request, options: PlaidRouteOptions = {}): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      publicToken?: unknown;
      public_token?: unknown;
      purpose?: unknown;
      bankAccountId?: unknown;
      accountId?: unknown;
    };
    const publicToken = typeof body.publicToken === "string" ? body.publicToken : typeof body.public_token === "string" ? body.public_token : "";
    const purpose = readPurpose(body.purpose, options);
    if (!publicToken || !purpose) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
    const actor = await authorizePlaidPurpose(purpose);
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });
    if (!(await withinLinkLimit(req, "exchange", actor.userId))) {
      return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429, headers: NO_STORE });
    }

    const result = await exchangePublicToken(
      { db: actor.db, client: getPlaidClient(), createItem: createPlaidItem, createBankAccount },
      {
        ownerUserId: actor.userId,
        purpose,
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
    logPlaidFailure("[plaid] exchange failed", error);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
