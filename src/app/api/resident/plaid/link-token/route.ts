import { plaidLinkTokenRoute } from "@/lib/plaid/link-routes.server";

export const runtime = "nodejs";

/**
 * The resident's own bank-pay Link token, pinned to `resident_pay`. It lives under `/api/resident`
 * because that prefix is on `MANAGED_READ_ONLY_ALLOWED_PATHS`: a locked managed-workspace client may
 * still pay her own rent from her resident portal, while the generic `/api/plaid/*` routes (which can
 * reach a manager's bank feed) stay refused for her. The pin is what makes that safe.
 */
export async function POST(req: Request) {
  return plaidLinkTokenRoute(req, { only: "resident_pay" });
}
