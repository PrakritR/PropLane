import { plaidExchangeRoute } from "@/lib/plaid/link-routes.server";

export const runtime = "nodejs";

/** Any enabled purpose (the manager's bank feed connects here). Implementation: `link-routes.server.ts`. */
export async function POST(req: Request) {
  return plaidExchangeRoute(req);
}
