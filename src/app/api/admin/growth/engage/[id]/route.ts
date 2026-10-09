import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { patchEngageItem } from "@/lib/growth/engage/items.server";
import { engageStatusSchema, uuidSchema } from "../../schemas";

export const runtime = "nodejs";

const body = z.object({ status: engageStatusSchema, draft: z.string().max(4000) }).partial().strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    if (b.status === undefined && b.draft === undefined) return json({ error: "Nothing to update." }, 400);
    return json({ item: await patchEngageItem(id, b) });
  });
}
