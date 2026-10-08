import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { replaceScenes } from "@/lib/growth/posts.server";
import { sceneListSchema } from "@/lib/growth/scenes";
import { uuidSchema } from "../../../schemas";

export const runtime = "nodejs";

const body = z.object({ scenes: sceneListSchema }).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ post: await replaceScenes(id, b.scenes) });
  });
}
