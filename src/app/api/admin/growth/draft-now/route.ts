import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { runDraftStep } from "@/lib/growth/draft-run.server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  return adminRoute(null, undefined, async () => json(await runDraftStep(3)));
}
