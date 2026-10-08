import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { publisherStatus } from "@/lib/growth/publishers/index.server";
import { loadAnalytics } from "@/lib/growth/analytics.server";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => json({ ...(await loadAnalytics()), publisher: publisherStatus() }));
}
