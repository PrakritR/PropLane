import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { findVendorDocument, isVendorDocumentKind } from "@/lib/vendor-documents";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { VENDOR_DOCUMENTS_BUCKET, isVendorDocumentStoragePath } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

/**
 * Legacy path — this used to stream the vendor's file directly, which broke
 * the private-bucket/signed-URL rule (docs/agents/documents-module.md).
 * Nothing in this app calls it any more (new code goes straight to
 * `/api/vendor/documents/signed-url`), but a document uploaded before this
 * change still carries this exact path as its stored, opaque `url` marker
 * (`vendor-documents.ts`'s `VendorDocumentRecord.url`), so this stays as a
 * locked-down redirect rather than disappearing outright: same ownership
 * re-derivation as the signed-url route, then a 302 to a freshly minted,
 * short-lived signed URL — never bytes streamed through this route again.
 */
export async function GET(req: Request) {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: auth.status },
      );
    }

    const kind = new URL(req.url).searchParams.get("kind") ?? "";
    if (!isVendorDocumentKind(kind)) {
      return NextResponse.json({ error: "Valid document kind required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const records = await resolveOwnVendorRecords(db, auth.userId);
    if (records.length === 0) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const doc = records.map((record) => findVendorDocument(record.row.vendorDocuments, kind)).find(Boolean);
    const storagePath = doc?.storagePath?.trim() ?? "";
    if (!doc || !storagePath || !isVendorDocumentStoragePath(storagePath, auth.userId)) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }

    const { data: signed, error } = await db.storage.from(VENDOR_DOCUMENTS_BUCKET).createSignedUrl(storagePath, 300);
    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: error?.message ?? "Failed to sign URL." }, { status: 500 });
    }

    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to open document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
