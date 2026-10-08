import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { updateIdea } from "@/lib/growth/ideas.server";
import { uuidSchema } from "../../schemas";

export const runtime = "nodejs";

const body = z.object({ weight: z.number().min(0).max(10), notes: z.string().max(2000).nullable() }).partial().strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ idea: await updateIdea(id, b) });
  });
}
