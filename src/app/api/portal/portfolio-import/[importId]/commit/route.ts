import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { draftHasBlockingIssues } from "@/lib/portfolio-import/build-draft";
import { commitPortfolioImport, PortfolioImportBlockedError } from "@/lib/portfolio-import/commit.server";
import { loadPortfolioImport, loadReceipts, summaryFor } from "@/lib/portfolio-import/store.server";
import type { PortfolioImportCommitResult, PortfolioImportRecordKind } from "@/lib/portfolio-import/types";

export const runtime = "nodejs";

const RECORD_KINDS: PortfolioImportRecordKind[] = ["property", "room", "resident", "balance", "task"];

async function requireOwnedImport(importId: string) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return { error: NextResponse.json({ error: "Sign in required." }, { status: 401 }) } as const;
  if (auth.role !== "manager" && auth.role !== "admin") {
    return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) } as const;
  }
  const row = await loadPortfolioImport(auth.db, auth.userId, importId);
  if (!row) return { error: NextResponse.json({ error: "Import not found." }, { status: 404 }) } as const;
  return { auth, row } as const;
}

export async function POST(_req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const found = await requireOwnedImport(importId);
  if ("error" in found) return found.error;
  const { auth, row } = found;

  if (row.status === "completed") {
    return NextResponse.json({ result: row.result ?? null, summary: summaryFor(row) }, { status: 200 });
  }

  const limited = await rateLimit(`portfolio-import-commit:${auth.userId}`, 10, 60_000);
  if (!limited.ok) return NextResponse.json({ error: "Too many commit requests. Try again shortly." }, { status: 429 });

  if (!row.draft) return NextResponse.json({ error: "Import has no draft to commit." }, { status: 409 });
  if (draftHasBlockingIssues(row.draft.draft)) {
    const count = row.draft.draft.issues.filter((i) => i.severity === "block" && !i.resolved).length;
    return NextResponse.json({ error: "blocking_issues", count }, { status: 409 });
  }

  const { data: profile } = await auth.db.from("profiles").select("full_name").eq("id", auth.userId).maybeSingle();

  try {
    const result = await commitPortfolioImport({
      db: auth.db,
      managerUserId: auth.userId,
      actor: { userId: auth.userId, email: auth.email, managerName: String(profile?.full_name ?? "") },
      importId,
    });
    const updated = await loadPortfolioImport(auth.db, auth.userId, importId);
    return NextResponse.json({ result, summary: updated ? summaryFor(updated) : null });
  } catch (err) {
    if (err instanceof PortfolioImportBlockedError) {
      const count = row.draft.draft.issues.filter((i) => i.severity === "block" && !i.resolved).length;
      return NextResponse.json({ error: "blocking_issues", count }, { status: 409 });
    }
    console.error("portfolio-import: commit failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not commit this import." }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const found = await requireOwnedImport(importId);
  if ("error" in found) return found.error;
  const { auth, row } = found;

  const stored = row.result as PortfolioImportCommitResult | null;
  if (stored?.progress) {
    return NextResponse.json({ status: row.status, progress: stored.progress });
  }

  const receipts = await loadReceipts(auth.db, importId);
  const progress = RECORD_KINDS.map((stage) => {
    const rows = receipts.filter((r) => r.record_kind === stage);
    return {
      stage,
      total: rows.length,
      done: rows.filter((r) => r.status === "completed").length,
      failed: rows.filter((r) => r.status !== "completed" && r.error).length,
    };
  });
  return NextResponse.json({ status: row.status, progress });
}
