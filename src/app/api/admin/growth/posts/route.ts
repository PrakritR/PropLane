import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { createManualPost, isPostStatus, listPosts, listPublicationSummaries } from "@/lib/growth/posts.server";
import { formatSchema, platformSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return adminRoute(null, undefined, async () => {
    const status = new URL(req.url).searchParams.get("status");
    if (status && !isPostStatus(status)) return json({ error: "Invalid status." }, 400);
    const posts = await listPosts(status && isPostStatus(status) ? status : undefined);
    const pubs = await listPublicationSummaries(posts.map((p) => p.id));
    return json({ posts: posts.map((p) => ({ ...p, publications: pubs[p.id] ?? [] })) });
  });
}

const createBody = z.object({ title: z.string().trim().min(1).max(200), format: formatSchema, platforms: z.array(platformSchema).min(1) });

export async function POST(req: Request) {
  return adminRoute(req, createBody, async ({ body }) => json({ post: await createManualPost(body) }, 201));
}
