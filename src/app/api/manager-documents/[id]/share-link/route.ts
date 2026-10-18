import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { assertManagerDocumentsCoManagerAccess } from "@/lib/auth/co-manager-access";
import { UUID_PATTERN } from "@/lib/documents/manager-documents";
import {
  buildDocumentShareUrl,
  createDocumentShareLink,
  listDocumentShareLinks,
  revokeDocumentShareLink,
} from "@/lib/documents/document-share-links.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

// Public share links must resolve to the canonical domain — never a *.vercel.app
// deploy URL — so a shared document link keeps working off any deploy.
function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const { data: doc } = await auth.db
      .from("manager_documents")
      .select("id, property_id, manager_user_id")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const cm = await assertManagerDocumentsCoManagerAccess(auth.db, auth.userId, doc.property_id, auth.userId);
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const links = await listDocumentShareLinks(auth.db, { documentId: id, managerUserId: auth.userId });
    const origin = appOrigin();
    return NextResponse.json({
      links: links.map((link) => ({
        ...link,
        // A link minted after the hash migration has no stored token: its URL was shown once, at creation.
        url: link.shareToken ? buildDocumentShareUrl(origin, link.shareToken) : null,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list share links.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { expiresInDays?: number };
    const { data: doc } = await auth.db
      .from("manager_documents")
      .select("id, property_id, manager_user_id")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const cm = await assertManagerDocumentsCoManagerAccess(auth.db, auth.userId, doc.property_id, auth.userId);
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const link = await createDocumentShareLink(auth.db, {
      documentId: id,
      managerUserId: auth.userId,
      createdBy: auth.userId,
      expiresInDays: body.expiresInDays,
    });
    const origin = appOrigin();
    return NextResponse.json({ link: { ...link, url: buildDocumentShareUrl(origin, link.shareToken) } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create share link.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json().catch(() => ({}))) as { linkId?: string };
    const linkId = body.linkId?.trim();
    if (!linkId) return NextResponse.json({ error: "linkId required." }, { status: 400 });

    const { data: doc } = await auth.db
      .from("manager_documents")
      .select("id")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    await revokeDocumentShareLink(auth.db, { linkId, managerUserId: auth.userId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to revoke share link.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
