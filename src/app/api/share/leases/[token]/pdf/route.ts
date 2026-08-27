import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { loadSharedLeasePdfBytes } from "@/lib/portal-record-share-payload.server";
import { resolvePortalRecordShareToken } from "@/lib/portal-record-share-links.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * The uploaded lease PDF's bytes for a share token (no auth).
 *
 * This exists to stop the document travelling inside the viewer's JSON as a base64 `data:` URL,
 * which was ~33% larger than the bytes, uncacheable, and re-sent in full on every page load — a
 * real egress cost on the free plan for a document that never changes.
 *
 * The caching shape is chosen around REVOCATION rather than raw hit rate. A share link can expire
 * or be revoked, so a long `max-age` would keep serving a withdrawn lease out of the viewer's own
 * cache with no way to reach it. `no-cache` plus a strong ETag means the browser asks every time —
 * the token is re-resolved on each request, so a revoked link stops working immediately — but an
 * unchanged document comes back as an empty 304 rather than megabytes. That removes essentially
 * all of the repeat egress while keeping revocation honest.
 *
 * `private` keeps it out of any shared/CDN cache: the response is a tenancy document, and the URL
 * is the only credential in front of it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const db = createSupabaseServiceRoleClient();
    const resolved = await resolvePortalRecordShareToken(db, decodeURIComponent(token));
    if (!resolved || resolved.link.recordKind !== "lease") {
      return NextResponse.json({ error: "Link expired or invalid." }, { status: 404 });
    }

    const bytes = await loadSharedLeasePdfBytes(db, resolved.link.recordId, {
      recordOwnerUserId: resolved.recordOwnerUserId,
    });
    if (!bytes) return NextResponse.json({ error: "Lease not found." }, { status: 404 });

    const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
    const headers = {
      "Content-Type": "application/pdf",
      // The bytes are already proven to be a PDF by the data-URL allowlist; `nosniff` stops a
      // browser reconsidering that and treating the response as something executable.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-cache",
      ETag: etag,
      // Named so a viewer who downloads it gets a filename rather than the token.
      "Content-Disposition": 'inline; filename="lease.pdf"',
    };

    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }

    return new NextResponse(new Uint8Array(bytes), { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "Could not load shared lease." }, { status: 500 });
  }
}
