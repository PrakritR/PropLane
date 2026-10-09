import { z } from "zod";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { growthDb, must } from "@/lib/growth/db.server";
import { listKeywords, mapKeyword } from "@/lib/growth/engage/watchlist.server";
import { uuidSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => json({ keywords: await listKeywords() }));
}

const body = z.object({
  keyword: z.string().trim().min(1).max(60),
  reply: z.string().trim().max(1000).nullish(),
  link: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "https only").nullish(),
});

export async function POST(req: Request) {
  return adminRoute(req, body, async ({ body: b }) => {
    const row = must(
      await growthDb()
        .from("growth_keywords")
        .upsert({ keyword: b.keyword.toUpperCase(), reply: b.reply ?? null, link: b.link ?? null, active: true }, { onConflict: "keyword" })
        .select("*")
        .single(),
      "add keyword",
    );
    return json({ keyword: mapKeyword(row) }, 201);
  });
}

export async function DELETE(req: Request) {
  return adminRoute(null, undefined, async () => {
    const id = new URL(req.url).searchParams.get("id");
    if (!id || !uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    must(await growthDb().from("growth_keywords").delete().eq("id", id), "delete keyword");
    return json({ ok: true });
  });
}
