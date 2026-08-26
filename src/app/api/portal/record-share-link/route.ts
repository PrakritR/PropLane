import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { managerCanAccessLeaseRecord } from "@/lib/auth/manager-lease-scope";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  buildPortalRecordShareUrl,
  createPortalRecordShareLink,
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

function applicationIdVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) => RECORD_ID_PATTERN.test(value));
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
    let allowed = admin;

    if (!allowed && kind === "lease") {
      const { data: record } = await db
        .from("portal_lease_pipeline_records")
        .select("id, manager_user_id, property_id")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) return NextResponse.json({ error: "Lease not found." }, { status: 404 });
      allowed = await managerCanAccessLeaseRecord(db, user.id, record, "read");
    }

    if (!allowed && kind === "application") {
      const ids = applicationIdVariants(recordId);
      if (ids.length === 0) return NextResponse.json({ error: "Application not found." }, { status: 404 });
      const { data: records } = await db
        .from("manager_application_records")
        .select("id, manager_user_id, property_id, assigned_property_id")
        .in("id", ids)
        .limit(1);
      const record = records?.[0];
      if (!record) return NextResponse.json({ error: "Application not found." }, { status: 404 });
      allowed = await managerCanAccessApplicationRecord(db, user.id, record, { level: "read" });
    }

    if (!allowed) return NextResponse.json({ error: "Not authorized." }, { status: 403 });

    const link = await createPortalRecordShareLink(db, {
      recordKind: kind,
      recordId,
      managerUserId: user.id,
      createdBy: user.id,
      expiresInDays: body.expiresInDays,
    });

    const origin = appOrigin();
    return NextResponse.json({
      link: { ...link, url: buildPortalRecordShareUrl(origin, kind, link.shareToken) },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create share link.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
