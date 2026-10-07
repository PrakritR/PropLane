import { notFound, redirect } from "next/navigation";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { buildVendorStatement } from "@/lib/vendor-banking/statement.server";
import { statementMonthLabel, VENDOR_STATEMENT_EVENT_LABELS } from "@/lib/vendor-banking/statement-events";
import { PrintButton } from "../../vendor-payout/[id]/print-button";
import { formatPacificDate } from "@/lib/pacific-time";

/**
 * A vendor's own monthly statement, printed straight from the browser (Print →
 * Save as PDF — the same no-PDF-library pattern as the payment receipt). Scoped
 * to the signed-in vendor's own ledger; a malformed month 404s.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

function usd(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function VendorStatementPrintPage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) notFound();
  if (!vendorBankingEnabled()) notFound();
  const access = await requireVendorApiAccess();
  if (!access.ok) redirect(`/auth/sign-in?next=${encodeURIComponent(`/print/vendor-statement/${month}`)}`);

  const db = createSupabaseServiceRoleClient();
  const statement = await buildVendorStatement(db, access.actor.userId, { month });
  const title = `Statement · ${statementMonthLabel(month)}`;

  return (
    <div className="print-root min-h-screen bg-[#eef0f4] px-4 py-6 print:bg-white print:p-0">
      <title>{title}</title>
      <div className="print-toolbar mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[#0b1120]/70">{title}</p>
        <PrintButton />
      </div>
      <article className="print-sheet mx-auto bg-white p-[0.7in] text-[#0b1120]" data-attr="print-vendor-statement">
        <header className="flex items-start justify-between gap-6 border-b border-black/10 pb-6">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">Statement</p>
            <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-tight">{statementMonthLabel(month)}</h1>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-black/45">PropLane</p>
        </header>
        <dl className="mt-6 grid grid-cols-2 gap-4">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Opening balance</dt>
            <dd className="text-[18px] font-semibold">{usd(statement.openingCents)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Closing balance</dt>
            <dd className="text-[18px] font-semibold">{usd(statement.closingCents)}</dd>
          </div>
        </dl>
        <table className="mt-6 w-full text-[13px]">
          <thead>
            <tr className="border-b border-black/15 text-left text-[11px] uppercase tracking-[0.08em] text-black/55">
              <th className="py-2 pr-3">Date</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Description</th>
              <th className="py-2 pr-3 text-right">Amount</th>
              <th className="py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) => (
              <tr key={line.id} className="border-b border-black/10">
                <td className="py-2 pr-3">{formatPacificDate(line.createdAt, { month: "short", day: "numeric" })}</td>
                <td className="py-2 pr-3">{VENDOR_STATEMENT_EVENT_LABELS[line.eventType]}</td>
                <td className="py-2 pr-3">{line.description}</td>
                <td className="py-2 pr-3 text-right">{usd(line.amountCents)}</td>
                <td className="py-2 text-right font-semibold">{usd(line.runningBalanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {statement.lines.length === 0 ? <p className="mt-6 text-[13px] text-black/55">No activity this month.</p> : null}
      </article>
      <style>{`
        .print-sheet { border-radius: 18px; box-shadow: 0 12px 34px rgba(8,9,11,.08); width: 8.5in; min-height: 6in; max-width: 100%; }
        @media print {
          @page { margin: 0; }
          html, body { background: #fff !important; }
          .print-root { padding: 0 !important; }
          .print-sheet { border-radius: 0; box-shadow: none; width: 8.5in; padding: 0.7in; }
        }
      `}</style>
    </div>
  );
}
