import { plaidExchangeRoute } from "@/lib/plaid/link-routes.server";

export const runtime = "nodejs";

/** The resident's own bank-pay exchange, pinned to `resident_pay`. See the sibling link-token route. */
export async function POST(req: Request) {
  return plaidExchangeRoute(req, { only: "resident_pay" });
}
