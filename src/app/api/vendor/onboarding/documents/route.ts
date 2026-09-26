import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { attachVendorOnboardingDocument } from "@/lib/vendor-business-profile.server";
import { VENDOR_DOCUMENTS_BUCKET } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const ONBOARDING_KINDS = new Set(["license", "insurance"]);

/**
 * Onboarding license/insurance uploads for a SELF-SERVE vendor — unlike
 * `/api/vendor/documents/upload`, this never requires a linked manager
 * (`resolveOwnVendorRecords`): the path is recorded on the vendor's own
 * `vendor_business_profiles` row, same private bucket and prefix convention
 * (`vendor-documents/<userId>/...`).
 */
export async function POST(req: Request) {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json({ error: auth.status === 401 ? "Unauthorized." : "Forbidden." }, { status: auth.status });
    }

    const body = (await req.json()) as { dataUrl?: string; kind?: string; fileName?: string; ext?: string };
    const kind = body.kind ?? "";
    if (!ONBOARDING_KINDS.has(kind)) {
      return NextResponse.json({ error: "Valid document kind required." }, { status: 400 });
    }

    const dataUrl = body.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "dataUrl required." }, { status: 400 });
    }

    const [header, b64] = dataUrl.split(",");
    if (!header || !b64) return NextResponse.json({ error: "Invalid data URL." }, { status: 400 });

    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? "application/pdf";
    if (!ALLOWED_MIME.has(mime)) {
      return NextResponse.json({ error: "Only PDF, JPEG, PNG, and WebP files are allowed." }, { status: 400 });
    }

    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > MAX_BYTES) {
      return NextResponse.json({ error: "File must be 5 MB or smaller." }, { status: 400 });
    }

    const ext =
      body.ext ??
      (mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");
    const storagePath = `vendor-documents/${auth.userId}/onboarding-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const db = createSupabaseServiceRoleClient();
    const { error: uploadError } = await db.storage.from(VENDOR_DOCUMENTS_BUCKET).upload(storagePath, bytes, {
      contentType: mime,
      cacheControl: "31536000",
      upsert: false,
    });
    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

    const attached = await attachVendorOnboardingDocument(db, auth.userId, kind as "license" | "insurance", storagePath);
    if (!attached.ok) return NextResponse.json({ error: attached.error }, { status: 500 });

    return NextResponse.json({ kind, storagePath });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
