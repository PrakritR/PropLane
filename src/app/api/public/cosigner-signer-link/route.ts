import { NextResponse } from "next/server";
import { loadCosignerSignerLinkPreview } from "@/lib/rental-application/cosigner-signer-link.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Read-only check that a primary application id can link a co-signer form. */
export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`cosigner-signer-link:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const url = new URL(req.url);
    const signerAppId = url.searchParams.get("signerAppId")?.trim() ?? "";
    if (!signerAppId) {
      return NextResponse.json(
        { ok: false, code: "invalid_id", message: "signerAppId is required." },
        { status: 400 },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const preview = await loadCosignerSignerLinkPreview(db, signerAppId);
    return NextResponse.json(preview, { status: preview.ok ? 200 : 404 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not verify that co-signer link.";
    return NextResponse.json({ ok: false, code: "not_found", message }, { status: 500 });
  }
}
