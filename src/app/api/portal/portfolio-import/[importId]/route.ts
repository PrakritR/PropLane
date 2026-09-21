import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { applyAnswersAndSkips, loadImportProposal, updateImportProposal } from "@/lib/portfolio-import/store.server";
import type { PortfolioImportUpdateRequest } from "@/lib/portfolio-import/types";

/** GET -> the stored proposal. PATCH { answers?, skips? } -> merges and recomputes status/summary. */
export const runtime = "nodejs";

async function authorize() {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return { ok: false as const, status: 401, error: "Sign in required." };
  if (auth.role !== "manager" && auth.role !== "admin") return { ok: false as const, status: 404, error: "Not found." };
  return { ok: true as const, auth };
}

export async function GET(_req: Request, { params }: { params: Promise<{ importId: string }> }) {
  const authz = await authorize();
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });
  const { importId } = await params;

  const loaded = await loadImportProposal(authz.auth.db, authz.auth.userId, importId);
  if (!loaded) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true, proposal: loaded.proposal, status: loaded.row.status });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ importId: string }> }) {
  const authz = await authorize();
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });
  const { importId } = await params;

  let body: PortfolioImportUpdateRequest;
  try {
    body = (await req.json()) as PortfolioImportUpdateRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (body.answers !== undefined && (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers))) {
    return NextResponse.json({ error: "answers must be an object." }, { status: 400 });
  }
  if (body.skips !== undefined && !Array.isArray(body.skips)) {
    return NextResponse.json({ error: "skips must be an array." }, { status: 400 });
  }

  const loaded = await loadImportProposal(authz.auth.db, authz.auth.userId, importId);
  if (!loaded) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const updated = applyAnswersAndSkips(loaded.proposal, body);
  try {
    await updateImportProposal(authz.auth.db, authz.auth.userId, importId, updated);
  } catch (err) {
    console.error("portfolio-import: update failed", err);
    return NextResponse.json({ error: "Could not save those changes. Try again in a moment." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, proposal: updated });
}
