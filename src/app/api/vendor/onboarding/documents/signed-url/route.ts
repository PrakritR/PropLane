import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";
import { VENDOR_DOCUMENTS_BUCKET } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

/**
 * Short-lived signed URL for the signed-in vendor's own onboarding document.
 * Bytes are never streamed inline from this route — the client fetches the
 * returned URL directly from private storage (documents-module pattern).
 */
export async function GET(req: Request) {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json({ error: auth.status === 401 ? "Unauthorized." : "Forbidden." }, { status: auth.status });
    }

    const kind = new URL(req.url).searchParams.get("kind") ?? "";
    if (kind !== "license" && kind !== "insurance") {
      return NextResponse.json({ error: "Valid document kind required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const profile = await loadVendorBusinessProfile(db, auth.userId);
    const storagePath = kind === "license" ? profile.licenseDocPath : profile.insuranceDocPath;
    if (!storagePath || !storagePath.startsWith(`vendor-documents/${auth.userId}/`)) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }

    const { data, error } = await db.storage.from(VENDOR_DOCUMENTS_BUCKET).createSignedUrl(storagePath, 300);
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not sign URL." }, { status: 500 });

    return NextResponse.json({ url: data.signedUrl }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not sign URL.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
