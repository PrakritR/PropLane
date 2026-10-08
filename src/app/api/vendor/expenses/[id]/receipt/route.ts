import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  VENDOR_EXPENSE_RECEIPT_MAX_BYTES,
  VENDOR_EXPENSE_RECEIPT_MIME,
} from "@/lib/vendor-expenses";
import { VENDOR_DOCUMENTS_BUCKET, isVendorDocumentStoragePath, vendorDocumentStoragePrefix } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Short-lived: one preview or download round trip, never a durable link. */
const RECEIPT_SIGNED_URL_TTL_SECONDS = 300;

async function requireVendor() {
  const auth = await resolveVendorPortalUserId();
  if (!auth.ok) {
    return { ok: false as const, status: auth.status, error: auth.status === 401 ? "Unauthorized." : "Forbidden." };
  }
  return { ok: true as const, userId: auth.userId, db: createSupabaseServiceRoleClient() };
}

/** The expense's receipt path, only if the expense is this vendor's. Null = not found. */
async function loadOwnReceiptPath(gate: { userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }, id: string) {
  const { data, error } = await gate.db
    .from("vendor_expense_entries")
    .select("id, receipt_path")
    .eq("id", id)
    .eq("vendor_user_id", gate.userId)
    .maybeSingle();
  if (error) return { error: error.message as string, found: false as const };
  if (!data) return { found: false as const };
  return { found: true as const, receiptPath: typeof data.receipt_path === "string" ? data.receipt_path : "" };
}

function extFor(mime: string): string {
  return mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

/** Mint a signed URL for the receipt. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const own = await loadOwnReceiptPath(gate, id);
    if ("error" in own && own.error) return NextResponse.json({ error: own.error }, { status: 500 });
    if (!own.found || !own.receiptPath || !isVendorDocumentStoragePath(own.receiptPath, gate.userId)) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }
    const { data: signed, error } = await gate.db.storage
      .from(VENDOR_DOCUMENTS_BUCKET)
      .createSignedUrl(own.receiptPath, RECEIPT_SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: error?.message ?? "Failed to sign URL." }, { status: 500 });
    }
    return NextResponse.json({ url: signed.signedUrl });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the receipt." }, { status: 500 });
  }
}

/** Attach (or replace) a receipt: `{ dataUrl }`, a PDF or image up to 5 MB, stored under the vendor's own prefix. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const own = await loadOwnReceiptPath(gate, id);
    if ("error" in own && own.error) return NextResponse.json({ error: own.error }, { status: 500 });
    if (!own.found) return NextResponse.json({ error: "Expense not found." }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { dataUrl?: unknown };
    const dataUrl = body.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "A receipt file is required." }, { status: 400 });
    }
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const b64 = dataUrl.slice(comma + 1);
    const mime = header.match(/^data:([^;]+)/)?.[1] ?? "";
    if (comma < 0 || !b64) return NextResponse.json({ error: "Invalid file." }, { status: 400 });
    if (!(VENDOR_EXPENSE_RECEIPT_MIME as readonly string[]).includes(mime)) {
      return NextResponse.json({ error: "Only PDF, JPEG, PNG, and WebP files are allowed." }, { status: 400 });
    }
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0 || bytes.length > VENDOR_EXPENSE_RECEIPT_MAX_BYTES) {
      return NextResponse.json({ error: "File must be 5 MB or smaller." }, { status: 400 });
    }

    // The path is built here from the session user and the expense id; a client never names it.
    const storagePath = `${vendorDocumentStoragePrefix(gate.userId)}expense-receipt-${id}-${Date.now()}.${extFor(mime)}`;
    const { error: uploadError } = await gate.db.storage.from(VENDOR_DOCUMENTS_BUCKET).upload(storagePath, bytes, {
      contentType: mime,
      cacheControl: "31536000",
      upsert: false,
    });
    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

    const { error: updateError } = await gate.db
      .from("vendor_expense_entries")
      .update({ receipt_path: storagePath, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("vendor_user_id", gate.userId);
    if (updateError) {
      await gate.db.storage.from(VENDOR_DOCUMENTS_BUCKET).remove([storagePath]).catch(() => undefined);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (own.receiptPath && isVendorDocumentStoragePath(own.receiptPath, gate.userId)) {
      await gate.db.storage.from(VENDOR_DOCUMENTS_BUCKET).remove([own.receiptPath]).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, hasReceipt: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save the receipt." }, { status: 500 });
  }
}

/** Remove the receipt file from an expense. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const own = await loadOwnReceiptPath(gate, id);
    if ("error" in own && own.error) return NextResponse.json({ error: own.error }, { status: 500 });
    if (!own.found) return NextResponse.json({ error: "Expense not found." }, { status: 404 });

    const { error } = await gate.db
      .from("vendor_expense_entries")
      .update({ receipt_path: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("vendor_user_id", gate.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (own.receiptPath && isVendorDocumentStoragePath(own.receiptPath, gate.userId)) {
      await gate.db.storage.from(VENDOR_DOCUMENTS_BUCKET).remove([own.receiptPath]).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, hasReceipt: false });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not remove the receipt." }, { status: 500 });
  }
}
