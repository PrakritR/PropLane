import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { summarizeDocumentExpiration } from "@/lib/documents/document-expiration";
import { applyWorkspaceRowScope, resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

/**
 * GET /api/manager-documents/expiration-summary — counts for dashboard /
 * compliance banner. Scoped by the SAME active-workspace rule as the library
 * list (`../route.ts`) — this is a roll-up total over exactly those rows, so
 * it must never disagree with what the list itself shows.
 */
export async function GET() {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
  const { data, error } = await applyWorkspaceRowScope(
    auth.db
      .from("manager_documents")
      .select("expires_at")
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .not("expires_at", "is", null)
      .limit(2000),
    scope,
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary = summarizeDocumentExpiration(
    (data ?? []).map((row) => ({ expiresAt: (row as { expires_at: string | null }).expires_at })),
  );

  return NextResponse.json({ summary });
}
