import { z } from "zod";
import { patchAccount } from "@/lib/growth/accounts.server";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { publisherSchema, uuidSchema } from "../../schemas";

export const runtime = "nodejs";

const body = z
  .object({
    status: z.enum(["connected", "expiring", "disconnected", "paused"]),
    handle: z.string().trim().min(1).max(120),
    vendorAccountId: z.string().trim().max(200).nullable(),
    publisher: publisherSchema,
  })
  .partial()
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return adminRoute(req, body, async ({ body: b }) => {
    const { id } = await params;
    if (!uuidSchema.safeParse(id).success) return json({ error: "Invalid id." }, 400);
    return json({ account: await patchAccount(id, b) });
  });
}
