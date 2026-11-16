import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { UUID_PATTERN } from "@/lib/documents/manager-documents";
import { attachExpenseReceipt, signedReceiptUrl } from "@/lib/finance/expense-receipt.server";
import { resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

/** GET: a short-lived signed URL for the entry's receipt. Always JSON, never a redirect (the native shell downloads a blob). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Expense not found." }, { status: 404 });
  const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const result = await signedReceiptUrl(auth.db, auth.userId, id, scope, download);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.value);
}

/** POST: multipart `file`. Replaces the link; the earlier receipt stays in the Library. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Expense not found." }, { status: 404 });
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required." }, { status: 400 });
  const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
  const result = await attachExpenseReceipt(auth.db, auth.userId, id, scope, {
    name: file.name,
    mime: file.type || "application/octet-stream",
    bytes: Buffer.from(await file.arrayBuffer()),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.value);
}
