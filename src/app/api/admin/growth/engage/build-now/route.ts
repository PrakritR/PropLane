import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { buildEngageList } from "@/lib/growth/engage/build.server";
import { pacificDate } from "@/lib/growth/engage/dates";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  return adminRoute(null, undefined, async () => json(await buildEngageList({ forDate: pacificDate() })));
}
