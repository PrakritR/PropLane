import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { approvePost } from "@/lib/growth/posts.server";
import { isoSchema, uuidSchema } from "../../../schemas";

export const runtime = "nodejs";

const body = z.object({ scheduledFor: isoSchema.nullish() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ userId, body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ post: await approvePost(id, userId, b.scheduledFor ?? null) });
  });
}
