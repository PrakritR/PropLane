import { z } from "zod";
import { defineTool } from "../registry";
import type { AgentContext } from "../context";
import { assertFinancialsTier } from "@/lib/reports/auth";
import { statementMatchReview } from "@/lib/statement-file-intake";

export const suggestStatementMatchesTool = defineTool({
  name: "suggest_bank_statement_matches",
  description: "Suggest owner-scoped income/expense matches for an imported bank statement by signed amount and dates within three days. Multiple candidates remain ambiguous. Creates no entries and clears nothing; use reconcile_bank_statement_line only after manager review.",
  inputSchema: z.object({ statementId: z.string().uuid() }).strict(),
  handler: async (ctx: AgentContext, input) => {
    const access = await assertFinancialsTier(ctx.landlordId);
    if (!access.ok) throw new Error(access.error);
    if (ctx.managerSmsAccess?.mode === "delegated") throw new Error("Open the owning manager's portal for bank reconciliation");
    const { data: statement, error } = await ctx.db.from("manager_bank_statements").select("id").eq("id", input.statementId).eq("manager_user_id", ctx.landlordId).single();
    if (error || !statement) throw new Error("Statement not found in your portfolio");
    const { data: lines, error: linesError } = await ctx.db.from("manager_bank_statement_lines").select("id,line_date,amount_cents,cleared").eq("statement_id", input.statementId).order("line_date").limit(1001);
    if (linesError || !lines || lines.length > 1000) throw new Error("Choose a statement with at most 1,000 lines");
    if (!lines.length) return { matches: [], count: 0 };
    const first = new Date(`${lines[0]!.line_date}T12:00:00Z`), last = new Date(`${lines.at(-1)!.line_date}T12:00:00Z`);
    first.setUTCDate(first.getUTCDate() - 3); last.setUTCDate(last.getUTCDate() + 3);
    const candidates: { id: string; kind: "income" | "expense"; date: string; amountCents: number }[] = [];
    for (const kind of ["income", "expense"] as const) {
      const table = kind === "income" ? "ledger_entries" : "manager_expense_entries", dateColumn = kind === "income" ? "posted_date" : "expense_date";
      for (let offset = 0; ; offset += 1000) {
        if (offset >= 10000) throw new Error("Too many candidate transactions; narrow the statement period");
        let query = ctx.db.from(table).select(`id,amount_cents,${dateColumn}`).eq("manager_user_id", ctx.landlordId).gte(dateColumn, first.toISOString().slice(0, 10)).lte(dateColumn, last.toISOString().slice(0, 10)).order("id").range(offset, offset + 999);
        if (kind === "income") query = query.eq("entry_type", "payment");
        const { data, error: candidateError } = await query;
        if (candidateError) throw new Error(candidateError.message);
        for (const row of (data ?? []) as unknown as Record<string, unknown>[]) candidates.push({ id: String(row.id), kind, date: String(row[dateColumn]), amountCents: Number(row.amount_cents) });
        if ((data?.length ?? 0) < 1000) break;
      }
    }
    const consumed = new Set<string>();
    for (const kind of ["income", "expense"] as const) {
      const ids = candidates.filter(c => c.kind === kind).map(c => c.id);
      const column = kind === "income" ? "matched_ledger_entry_id" : "matched_expense_entry_id";
      for (let offset = 0; offset < ids.length; offset += 100) {
        const { data, error } = await ctx.db.from("manager_bank_statement_lines")
          .select(`${column},manager_bank_statements!inner(manager_user_id)`)
          .eq("manager_bank_statements.manager_user_id", ctx.landlordId).in(column, ids.slice(offset, offset + 100));
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as unknown as Record<string, unknown>[]) consumed.add(`${kind}:${row[column]}`);
      }
    }
    const available = candidates.filter(c => !consumed.has(`${c.kind}:${c.id}`));
    const pending = lines.filter(line => !line.cleared);
    return { count: pending.length, matches: statementMatchReview(
      pending.map(line => ({ id: line.id, lineDate: line.line_date, amountCents: Number(line.amount_cents) })),
      available,
    ) };
  },
});
