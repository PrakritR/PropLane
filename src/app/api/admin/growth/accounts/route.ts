import { z } from "zod";
import { createAccount, listAccounts } from "@/lib/growth/accounts.server";
import { adminRoute, json } from "@/lib/growth/admin-api.server";
import { publisherStatus } from "@/lib/growth/publishers/index.server";
import { platformSchema, publisherSchema } from "../schemas";

export const runtime = "nodejs";

export async function GET() {
  return adminRoute(null, undefined, async () => json({ accounts: await listAccounts(), publisher: publisherStatus() }));
}

// Never accept tokens here: vendor keys live in env only.
const body = z.object({
  platform: platformSchema,
  handle: z.string().trim().min(1).max(120),
  publisher: publisherSchema.default("log"),
  vendorAccountId: z.string().trim().max(200).nullish(),
});

export async function POST(req: Request) {
  return adminRoute(req, body, async ({ body: b }) => json({ account: await createAccount(b) }, 201));
}
