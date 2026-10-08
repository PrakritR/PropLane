import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { retryPublication } from "@/lib/growth/posts.server";
import { uuidSchema } from "../../../schemas";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(null, undefined, async () => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ publication: await retryPublication(id) });
  });
}
