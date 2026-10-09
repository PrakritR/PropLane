import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { growthDb, must } from "@/lib/growth/db.server";
import { mapWatch } from "@/lib/growth/engage/watchlist.server";
import { watchKindSchema, uuidSchema } from "../../schemas";

export const runtime = "nodejs";

const patch = z
  .object({
    active: z.boolean(),
    kind: watchKindSchema,
    topic: z.string().trim().max(200).nullable(),
    notes: z.string().max(2000).nullable(),
    url: z.string().trim().url().max(500).nullable(),
  })
  .partial()
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, patch, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    if (Object.keys(b).length === 0) return json({ error: "Nothing to update." }, 400);
    const row = must(await growthDb().from("growth_watchlist").update(b).eq("id", id).select("*").maybeSingle(), "update watchlist entry");
    if (!row) return json({ error: "Watchlist entry not found" }, 404);
    return json({ entry: mapWatch(row) });
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(null, undefined, async () => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    must(await growthDb().from("growth_watchlist").delete().eq("id", id), "delete watchlist entry");
    return json({ ok: true });
  });
}
