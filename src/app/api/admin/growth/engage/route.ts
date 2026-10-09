import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { pacificDate } from "@/lib/growth/engage/dates";
import { listEngageItems } from "@/lib/growth/engage/items.server";
import { dateSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return adminRoute(null, undefined, async () => {
    const raw = new URL(req.url).searchParams.get("date");
    if (raw && !dateSchema.safeParse(raw).success) return json({ error: "Invalid date." }, 400);
    const date = raw ?? pacificDate();
    const items = await listEngageItems(date);
    const counts = {
      total: items.length,
      open: items.filter((i) => i.status === "open").length,
      done: items.filter((i) => i.status === "done").length,
      skipped: items.filter((i) => i.status === "skipped").length,
    };
    return json({ date, items, counts });
  });
}
