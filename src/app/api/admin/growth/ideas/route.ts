import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { ensureSeedIdeas, insertIdea, listIdeas } from "@/lib/growth/ideas.server";
import { angleSchema, formatSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => {
    await ensureSeedIdeas();
    return json({ ideas: await listIdeas() });
  });
}

const body = z.object({
  title: z.string().trim().min(1).max(200),
  angle: angleSchema,
  format: formatSchema,
  notes: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  return adminRoute(req, body, async ({ body: b }) => json({ idea: await insertIdea({ ...b, source: "manual" }) }, 201));
}
