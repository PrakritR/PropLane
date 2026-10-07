import { notFound, redirect } from "next/navigation";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PrintButton } from "../../vendor-payout/[id]/print-button";

/**
 * A vendor's own withdrawal receipt (a payout from their balance to their bank).
 * Scoped to the signed-in vendor's own `stripe_payouts` row — another vendor's
 * id 404s rather than 403s.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

type WithdrawalRow = {
  id: string;
  amount_cents: number;
  fee_cents: number | null;
  method: string | null;
  status: string;
  destination_last4: string | null;
  created_at: string;
  arrival_date: string | null;
};

function usd(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default async function VendorWithdrawalReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireVendorApiAccess();
  if (!access.ok) redirect(`/auth/sign-in?next=${encodeURIComponent(`/print/vendor-withdrawal/${id}`)}`);

  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("stripe_payouts")
    .select("id, amount_cents, fee_cents, method, status, destination_last4, created_at, arrival_date")
    .eq("id", id)
    .eq("manager_user_id", access.actor.userId)
    .maybeSingle();
  if (!data) notFound();
  const row = data as WithdrawalRow;
  const fee = row.method === "instant" ? Math.max(0, row.fee_cents ?? 0) : 0;
  const title = `Withdrawal receipt · ${usd(row.amount_cents)}`;

  return (
    <div className="print-root min-h-screen bg-[#eef0f4] px-4 py-6 print:bg-white print:p-0">
      <title>{title}</title>
      <div className="print-toolbar mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[#0b1120]/70">{title}</p>
        <PrintButton />
      </div>
      <article className="print-sheet mx-auto bg-white p-[0.7in] text-[#0b1120]" data-attr="print-vendor-withdrawal-receipt">
        <header className="flex items-start justify-between gap-6 border-b border-black/10 pb-6">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">Withdrawal receipt</p>
            <h1 className="mt-1 text-[30px] font-bold leading-tight tracking-tight">{usd(row.amount_cents)}</h1>
            <p className="mt-1 text-[14px] text-black/70">
              {row.method === "instant" ? "Instant" : "Standard"} withdrawal · {day(row.created_at)}
            </p>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-black/45">PropLane</p>
        </header>
        <dl className="mt-6 divide-y divide-black/10">
          {[
            ["Amount", usd(row.amount_cents)],
            ...(fee > 0 ? [["Instant payout fee", `−${usd(fee)}`]] : []),
            ["Sent to your bank", usd(row.amount_cents - fee)],
            ["To", row.destination_last4 ? `Account ····${row.destination_last4}` : "Your payout account"],
            ["Arrival", day(row.arrival_date)],
            ["Status", row.status.replace(/_/g, " ")],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">{label}</dt>
              <dd className="text-right text-[15px] font-semibold capitalize">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-[11px] text-black/45">Withdrawal id {row.id}</p>
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
