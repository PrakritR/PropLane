import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { authorizePortalRecordShare } from "@/lib/portal-record-share-authorize.server";
import {
  buildPortalRecordShareUrl,
  createPortalRecordShareLink,
  revokePortalRecordShareLinks,
  type PortalRecordShareKind,
} from "@/lib/portal-record-share-links.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

function parseKind(raw: unknown): PortalRecordShareKind | null {
  return raw === "lease" || raw === "application" ? raw : null;
}

function shareLinkSetupError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code ?? "") : "";
  if (
    message.includes("portal_record_share_links") ||
    code === "PGRST205" ||
    message.toLowerCase().includes("schema cache")
  ) {
    return NextResponse.json(
      {
        error:
          "Share links need a database update. Run npm run db:apply-sql for the portal_record_share_links migrations on the dev project.",
      },
      { status: 503 },
    );
  }
  console.error("[record-share-link] mint failed:", error);
  return NextResponse.json({ error: "Failed to create share link." }, { status: 500 });
}

/** Mint a public view link for one lease or application (manager auth). */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      kind?: string;
      recordId?: string;
      expiresInDays?: number;
    };
    const kind = parseKind(body.kind);
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    if (!kind || !recordId) {
      return NextResponse.json({ error: "kind and recordId are required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const authz = await authorizePortalRecordShare(db, user.id, kind, recordId, "edit");
    if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });

    const link = await createPortalRecordShareLink(db, {
      recordKind: kind,
      recordId: authz.canonicalRecordId,
      managerUserId: authz.recordOwnerUserId,
      createdBy: user.id,
      expiresInDays: body.expiresInDays,
    });

    const origin = appOrigin();
    return NextResponse.json({
      link: { ...link, url: buildPortalRecordShareUrl(origin, kind, link.shareToken) },
    });
  } catch (error) {
    return shareLinkSetupError(error);
  }
}

/** Revoke all active public view links for one lease or application (manager auth). */
export async function DELETE(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      kind?: string;
      recordId?: string;
    };
    const kind = parseKind(body.kind);
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    if (!kind || !recordId) {
      return NextResponse.json({ error: "kind and recordId are required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const authz = await authorizePortalRecordShare(db, user.id, kind, recordId, "edit");
    if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });

    const revokedCount = await revokePortalRecordShareLinks(db, {
      recordKind: kind,
      recordId: authz.canonicalRecordId,
      managerUserId: authz.recordOwnerUserId,
    });

    return NextResponse.json({ ok: true, revokedCount });
  } catch {
    return NextResponse.json({ error: "Failed to revoke share links." }, { status: 500 });
  }
}
