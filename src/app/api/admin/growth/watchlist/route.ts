import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { growthDb, must } from "@/lib/growth/db.server";
import { mapWatch } from "@/lib/growth/engage/watchlist.server";
import { engagePlatformSchema, watchKindSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => {
    const rows = must(await growthDb().from("growth_watchlist").select("*").order("created_at", { ascending: true }), "list watchlist");
    return json({ watchlist: (rows as Record<string, unknown>[]).map(mapWatch) });
  });
}

const body = z.object({
  platform: engagePlatformSchema,
  handle: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "https only").nullish(),
  topic: z.string().trim().max(200).nullish(),
  kind: watchKindSchema.default("engage"),
  notes: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  return adminRoute(req, body, async ({ body: b }) => {
    const row = must(
      await growthDb()
        .from("growth_watchlist")
        .upsert(
          { platform: b.platform, handle: b.handle, url: b.url ?? null, topic: b.topic ?? null, kind: b.kind, notes: b.notes ?? null, active: true },
          { onConflict: "platform,handle" },
        )
        .select("*")
        .single(),
      "add watchlist entry",
    );
    return json({ entry: mapWatch(row) }, 201);
  });
}
