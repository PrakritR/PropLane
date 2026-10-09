import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { videoDriverStatus } from "@/lib/growth/video/index.server";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => json({ status: videoDriverStatus() }));
}
