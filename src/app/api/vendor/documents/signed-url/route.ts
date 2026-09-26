import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { findVendorDocument, isVendorDocumentKind } from "@/lib/vendor-documents";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { VENDOR_DOCUMENTS_BUCKET, isVendorDocumentStoragePath } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

/** Short-lived — long enough for one preview or download round trip, never a durable link. */
const VENDOR_DOCUMENT_SIGNED_URL_TTL_SECONDS = 300;

function contentTypeForStoragePath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Mints a short-lived signed URL for a vendor's own compliance document —
 * the private bucket + signed-URL rule (docs/agents/documents-module.md:
 * "Private bucket; bytes only via server-minted signed URLs"), the same
 * pattern `/api/vendor/shared-documents/[id]/signed-url` already uses.
 *
 * Ownership is re-derived from the authenticated session on every call: the
 * `kind` query param only selects among the CALLER's own linked-manager
 * documents (`resolveOwnVendorRecords` keys strictly off `auth.userId`), and
 * the resolved storage path is re-checked against the caller's own prefix
 * before signing. A kind in the request is a selector, never authorization —
 * there is no id here a client could substitute to reach another vendor's
 * file.
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

    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") ?? "";
    if (!isVendorDocumentKind(kind)) {
      return NextResponse.json({ error: "Valid document kind required." }, { status: 400 });
    }
    const download = url.searchParams.get("download") === "1";

    const db = createSupabaseServiceRoleClient();
    const records = await resolveOwnVendorRecords(db, auth.userId);
    if (records.length === 0) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const doc = records.map((record) => findVendorDocument(record.row.vendorDocuments, kind)).find(Boolean);
    const storagePath = doc?.storagePath?.trim() ?? "";
    if (!doc || !storagePath || !isVendorDocumentStoragePath(storagePath, auth.userId)) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }

    const { data: signed, error } = await db.storage
      .from(VENDOR_DOCUMENTS_BUCKET)
      .createSignedUrl(
        storagePath,
        VENDOR_DOCUMENT_SIGNED_URL_TTL_SECONDS,
        download ? { download: doc.fileName } : undefined,
      );
    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: error?.message ?? "Failed to sign URL." }, { status: 500 });
    }

    // Always JSON, never a redirect: the client fetches this URL itself (for
    // preview) or fetches-then-blobs it (for download, `triggerDocumentDownload`)
    // so a download never depends on a cross-origin redirect's own disposition —
    // the same reason `/api/manager-documents/[id]/signed-url` never 302s.
    return NextResponse.json({
      url: signed.signedUrl,
      fileName: doc.fileName,
      mimeType: contentTypeForStoragePath(storagePath),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to open document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
