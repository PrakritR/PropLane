import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { UUID_PATTERN } from "@/lib/documents/manager-documents";
import { createManagerDocumentSignedUrl, resolveDownloadName } from "@/lib/documents/document-signed-url.server";
import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { resolveActiveWorkspaceRowScope, rowAllowedInWorkspaceScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

// GET /api/manager-documents/[id]/signed-url — return a short-lived signed URL
// for previewing/downloading a document the signed-in manager owns.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { data: row, error } = await auth.db
    .from("manager_documents")
    .select("manager_user_id, property_id, storage_path, display_name, original_filename, mime_type")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  // Access: the owner always; otherwise a co-manager with the documents module on
  // the document's property. Manager-level docs (property_id null) of other owners
  // are never reachable — the `.has(property_id)` check only matches property-scoped
  // rows on linked properties. A denial returns the same 404 as a missing row so
  // existence is not leaked.
  let allowed = row.manager_user_id === auth.userId;
  if (!allowed && row.property_id) {
    const linkedPropertyIds = await linkedPropertyIdsForModule(auth.db, auth.userId, "documents");
    allowed = linkedPropertyIds.has(row.property_id);
  }
  if (allowed) {
    // Bytes are only ever reached through this signed URL, so this is the
    // "act" half of workspace scoping: a document outside the manager's
    // active workspace must not be mintable even though the ownership /
    // co-manager check above already passed. Same 404 as a missing row —
    // the workspace boundary never leaks which documents exist elsewhere.
    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    if (!rowAllowedInWorkspaceScope(scope, row.property_id)) allowed = false;
  }
  if (!allowed) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const download = new URL(req.url).searchParams.get("download") === "1";
  const signed = await createManagerDocumentSignedUrl(auth.db, row, download);
  if ("error" in signed) return NextResponse.json({ error: signed.error }, { status: 500 });

  // Always JSON — the client fetches the signed URL and saves it as a blob so a
  // download behaves the same in the browser and inside the Capacitor WebView
  // (a 302 to storage would open a new tab in the native shell).
  return NextResponse.json({
    url: signed.signedUrl,
    mimeType: row.mime_type,
    displayName: row.display_name,
    ...(download ? { fileName: resolveDownloadName(row) } : {}),
  });
}
