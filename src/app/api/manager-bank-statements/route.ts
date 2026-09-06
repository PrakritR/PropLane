import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { createBankStatement, listBankStatements } from "@/lib/manager-bank-reconciliation.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const bankAccountId = new URL(req.url).searchParams.get("bankAccountId")?.trim() || undefined;
    const statements = await listBankStatements(auth.db, auth.userId, bankAccountId);
    return NextResponse.json({ statements });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to list statements." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      sourceFileName?: string;
      sourceFileSha256?: string;
      bankAccountId?: string;
      statementDate?: string;
      openingBalanceCents?: number;
      closingBalanceCents?: number;
      lines?: { lineDate: string; description: string; amountCents: number }[];
    };
    const statement = await createBankStatement(auth.db, {
      managerUserId: auth.userId,
      sourceFileName: typeof body.sourceFileName === "string" ? body.sourceFileName : undefined,
      sourceFileSha256: typeof body.sourceFileSha256 === "string" ? body.sourceFileSha256 : undefined,
      bankAccountId: String(body.bankAccountId ?? "").trim(),
      statementDate: String(body.statementDate ?? new Date().toISOString().slice(0, 10)),
      openingBalanceCents: Number(body.openingBalanceCents ?? 0),
      closingBalanceCents: Number(body.closingBalanceCents ?? 0),
      lines: Array.isArray(body.lines) ? body.lines : [],
    });
    return NextResponse.json({ statement });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create statement." }, { status: 500 });
  }
}
