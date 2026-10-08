import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { sendBackPost } from "@/lib/growth/posts.server";
import { uuidSchema } from "../../../schemas";

export const runtime = "nodejs";

const body = z.object({ note: z.string().trim().min(1).max(2000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ post: await sendBackPost(id, b.note) });
  });
}
