import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { growthDb } from "@/lib/growth/db.server";
import { getPost } from "@/lib/growth/posts.server";
import { RENDER_FORMATS, RENDER_STATUSES } from "@/lib/growth/types";
import { uuidSchema } from "../../../schemas";

export const runtime = "nodejs";

/**
 * Records a render request. Vercel never renders: the cockpit Mac picks the flag up
 * (`scripts/growth-render.mjs --pending`) or the admin runs the runbook command.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(null, undefined, async () => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    const post = await getPost(id);
    if (!post) return json({ error: "Post not found" }, 404);
    const command = `node scripts/growth-render.mjs ${id}`;
    // Only flag what the nightly run actually looks at; anything else has to be rendered by hand.
    if (!RENDER_FORMATS.includes(post.format)) return json({ error: `A ${post.format} post has no render.` }, 400);
    if (!RENDER_STATUSES.includes(post.status)) {
      return json({ error: `A ${post.status} post is not in the nightly render set (${RENDER_STATUSES.join(", ")}).`, command }, 409);
    }
    const db = growthDb();
    const cur = await db.from("growth_posts").select("meta").eq("id", id).maybeSingle();
    if (cur.error) {
      return json(
        {
          error: "Render requests are not recorded yet (growth_posts.meta is missing). Run the render on the cockpit Mac.",
          command,
        },
        501,
      );
    }
    const meta = { ...((cur.data as { meta?: Record<string, unknown> } | null)?.meta ?? {}), renderRequested: true, renderRequestedAt: new Date().toISOString() };
    const upd = await db.from("growth_posts").update({ meta }).eq("id", id);
    if (upd.error) return json({ error: `Could not record the render request: ${upd.error.message}`, command }, 501);
    return json({ ok: true, renderRequested: true, command });
  });
}
