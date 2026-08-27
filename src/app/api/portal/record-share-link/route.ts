import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { managerCanAccessLeaseRecord } from "@/lib/auth/manager-lease-scope";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { applicationIdVariants } from "@/lib/portal-record-share-payload.server";
import {
  buildPortalRecordShareUrl,
  createPortalRecordShareLink,
  revokePortalRecordShareLinks,
  type PortalRecordShareKind,
} from "@/lib/portal-record-share-links.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

function parseKind(raw: unknown): PortalRecordShareKind | null {
  return raw === "lease" || raw === "application" ? raw : null;
}

async function authorizeRecordShareMint(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  admin: boolean,
  kind: PortalRecordShareKind,
  recordId: string,
): Promise<{ allowed: boolean; canonicalRecordId: string; recordOwnerUserId: string }> {
  if (kind === "lease") {
    const { data: record } = await db
      .from("portal_lease_pipeline_records")
      .select("id, manager_user_id, property_id")
      .eq("id", recordId)
      .maybeSingle();
    if (!record) return { allowed: false, canonicalRecordId: "", recordOwnerUserId: "" };
    const allowed = admin || (await managerCanAccessLeaseRecord(db, userId, record, "edit"));
    return {
      allowed,
      canonicalRecordId: String(record.id),
      recordOwnerUserId: String(record.manager_user_id),
    };
  }

  const ids = applicationIdVariants(recordId);
  if (ids.length === 0) return { allowed: false, canonicalRecordId: "", recordOwnerUserId: "" };
  const { data: records } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, property_id, assigned_property_id")
    .in("id", ids);
  const trimmed = recordId.trim();
  const record =
    records?.find((row) => row.id === trimmed) ??
    records?.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  if (!record) return { allowed: false, canonicalRecordId: "", recordOwnerUserId: "" };
  const allowed = admin || (await managerCanAccessApplicationRecord(db, userId, record, { level: "edit" }));
  return {
    allowed,
    canonicalRecordId: String(record.id),
    recordOwnerUserId: String(record.manager_user_id),
  };
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
    if (!kind || !recordId || !RECORD_ID_PATTERN.test(recordId)) {
      return NextResponse.json({ error: "kind and recordId are required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { allowed, canonicalRecordId, recordOwnerUserId } = await authorizeRecordShareMint(
      db,
      user.id,
      admin,
      kind,
      recordId,
    );

    if (!canonicalRecordId) {
      return NextResponse.json({ error: kind === "lease" ? "Lease not found." : "Application not found." }, { status: 404 });
    }
    if (!allowed) return NextResponse.json({ error: "Not authorized." }, { status: 403 });

    const link = await createPortalRecordShareLink(db, {
      recordKind: kind,
      recordId: canonicalRecordId,
      managerUserId: recordOwnerUserId,
      createdBy: user.id,
      expiresInDays: body.expiresInDays,
    });

    const origin = appOrigin();
    return NextResponse.json({
      link: { ...link, url: buildPortalRecordShareUrl(origin, kind, link.shareToken) },
    });
  } catch {
    return NextResponse.json({ error: "Failed to create share link." }, { status: 500 });
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
    if (!kind || !recordId || !RECORD_ID_PATTERN.test(recordId)) {
      return NextResponse.json({ error: "kind and recordId are required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { allowed, canonicalRecordId, recordOwnerUserId } = await authorizeRecordShareMint(
      db,
      user.id,
      admin,
      kind,
      recordId,
    );

    if (!canonicalRecordId) {
      return NextResponse.json({ error: kind === "lease" ? "Lease not found." : "Application not found." }, { status: 404 });
    }
    if (!allowed) return NextResponse.json({ error: "Not authorized." }, { status: 403 });

    const revokedCount = await revokePortalRecordShareLinks(db, {
      recordKind: kind,
      recordId: canonicalRecordId,
      managerUserId: recordOwnerUserId,
    });

    return NextResponse.json({ ok: true, revokedCount });
  } catch {
    return NextResponse.json({ error: "Failed to revoke share links." }, { status: 500 });
  }
}
