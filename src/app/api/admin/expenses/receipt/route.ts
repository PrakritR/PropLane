import { NextResponse } from "next/server";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import {
  createReceiptUpload,
  deleteExpenseSchema,
  getReceiptSignedUrl,
  receiptUploadSchema,
} from "@/lib/admin/platform-expenses.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function failure(action: string, error: unknown) {
  if (error instanceof AdminInputError) return json({ error: error.message }, error.status);
  console.error(`${action} /api/admin/expenses/receipt failed`, error);
  return json({ error: "Receipt storage is unavailable. Try again." }, 502);
}

/** GET /api/admin/expenses/receipt?id=<expense id> — a five-minute signed link to the receipt. */
export async function GET(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = deleteExpenseSchema.safeParse({ id: new URL(req.url).searchParams.get("id") });
  if (!parsed.success) return json({ error: "Invalid expense id." }, 400);
  try {
    const url = await getReceiptSignedUrl(parsed.data.id);
    return url ? json({ url }) : json({ error: "This expense has no receipt." }, 404);
  } catch (error) {
    return failure("GET", error);
  }
}

/** POST /api/admin/expenses/receipt — `{ fileName, mimeType, sizeBytes }` -> a signed upload slot. */
export async function POST(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = receiptUploadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Invalid receipt." }, 400);
  try {
    return json(await createReceiptUpload(parsed.data));
  } catch (error) {
    return failure("POST", error);
  }
}
