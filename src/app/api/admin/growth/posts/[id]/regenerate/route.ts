import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { regeneratePost } from "@/lib/growth/posts.server";
import { uuidSchema } from "../../../schemas";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(null, undefined, async () => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ post: await regeneratePost(id) });
  });
}
