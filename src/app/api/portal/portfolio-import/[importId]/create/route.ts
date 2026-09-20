import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import { createPortfolioImportRecords, PortfolioImportNotFoundError } from "@/lib/portfolio-import/create.server";
import type { PortfolioImportCreateRequest } from "@/lib/portfolio-import/types";

/**
 * POST { sendInvites, answers?, skips? } -> real properties/residents/leases/
 * charges/tasks, one property at a time (create.server.ts owns the per-
 * property rollback and the exact paths reused). Never invites unless
 * `sendInvites === true`.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ importId: string }> }) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { importId } = await params;

  let body: PortfolioImportCreateRequest;
  try {
    const raw = (await req.json()) as Partial<PortfolioImportCreateRequest>;
    body = {
      sendInvites: raw.sendInvites === true,
      answers: raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers) ? raw.answers : undefined,
      skips: Array.isArray(raw.skips) ? raw.skips.filter((s): s is string => typeof s === "string") : undefined,
    };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const result = await createPortfolioImportRecords(
      auth.db,
      { userId: auth.userId, email: auth.email, managerName: auth.email },
      importId,
      body,
    );
    track("portfolio_import_created", auth.userId, {
      properties: result.created.properties,
      rooms: result.created.rooms,
      residents: result.created.residents,
      leases: result.created.leases,
      charges: result.created.charges,
      tasks: result.created.tasks,
      invites: result.created.invites,
      failures: result.failures.length,
      sendInvites: body.sendInvites,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PortfolioImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    console.error("portfolio-import: create failed", err);
    return NextResponse.json({ error: "Could not create those records. Try again in a moment." }, { status: 500 });
  }
}
