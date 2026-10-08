import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { growthDb, mapAsset, must } from "@/lib/growth/db.server";
import { getPost, listPublications, patchPost } from "@/lib/growth/posts.server";
import { isoSchema, platformSchema, sceneSchema, uuidSchema } from "../../schemas";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return adminRoute(null, undefined, async () => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    const post = await getPost(id);
    if (!post) return json({ error: "Post not found" }, 404);
    const assetRows = must(await growthDb().from("growth_assets").select("*").eq("post_id", id).order("created_at"), "assets") as Record<string, unknown>[];
    return json({ post: { ...post, assets: assetRows.map(mapAsset) }, publications: await listPublications(id) });
  });
}

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    hook: z.string().nullable(),
    script: z.string().nullable(),
    scenes: z.array(sceneSchema).max(12),
    captions: z.record(platformSchema, z.string()),
    platforms: z.array(platformSchema).min(1),
    scheduledFor: isoSchema.nullable(),
  })
  .partial()
  .strict();

export async function PATCH(req: Request, { params }: Ctx) {
  return adminRoute(req, patchBody, async ({ body }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ post: await patchPost(id, body) });
  });
}
