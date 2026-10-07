import { notFound, redirect } from "next/navigation";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { formatInvoiceMoney } from "@/lib/vendor-invoices";
import { vendorPaymentDetailBreakdown } from "@/lib/vendor-payments";
import type { VendorPayout, VendorPayoutStatus } from "@/lib/vendor-payouts";
import { PrintButton } from "./print-button";

/**
 * VD53 — a vendor's own payment receipt, printed straight from the browser
 * (the house-printables / inspection `/print/<kind>/[id]` pattern — no PDF
 * library, `@media print` does the layout). Scoped to the signed-in vendor's
 * OWN `vendor_payouts` row; another vendor's payout id 404s rather than 403s
 * (never confirms it exists).
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

type PayoutRow = {
  id: string;
  amount_cents: number;
  status: VendorPayoutStatus;
  created_at: string;
  updated_at: string | null;
  platform_fee_cents: number | null;
  refunded_gross_cents: number | null;
  manager_user_id: string | null;
  work_order_id: string | null;
  invoice_id: string | null;
};

export default async function VendorPayoutReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireVendorApiAccess();
  if (!access.ok) redirect(`/auth/sign-in?next=${encodeURIComponent(`/print/vendor-payout/${id}`)}`);

  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("vendor_payouts")
    .select("id, amount_cents, status, created_at, updated_at, platform_fee_cents, refunded_gross_cents, manager_user_id, work_order_id, invoice_id")
    .eq("id", id)
    .eq("vendor_user_id", access.actor.userId)
    .maybeSingle();
  if (!data) notFound();
  const row = data as PayoutRow;

  let managerName = "Manager";
  let invoiceNumber: string | null = null;
  if (row.manager_user_id) {
    const { data: manager } = await db.from("profiles").select("full_name").eq("id", row.manager_user_id).maybeSingle();
    managerName = (manager?.full_name as string | undefined)?.trim() || "Manager";
  }
  if (row.invoice_id) {
    const { data: invoice } = await db.from("vendor_invoices").select("invoice_number").eq("id", row.invoice_id).maybeSingle();
    invoiceNumber = (invoice?.invoice_number as string | null) ?? null;
  }

  const payout: VendorPayout = {
    id: row.id,
    workOrderId: row.work_order_id,
    invoiceId: row.invoice_id,
    amountCents: row.amount_cents,
    stripeTransferId: null,
    status: row.status,
    failureReason: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    platformFeeCents: row.platform_fee_cents ?? 0,
    refundedGrossCents: row.refunded_gross_cents ?? 0,
    refundedFeeCents: 0,
  };
  const breakdown = vendorPaymentDetailBreakdown(payout);
  const paidDate = new Date(row.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const title = `Receipt · ${formatInvoiceMoney(breakdown.grossCents)}`;

  return (
    <div className="print-root min-h-screen bg-[#eef0f4] px-4 py-6 print:bg-white print:p-0">
      <title>{title}</title>
      <div className="print-toolbar mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[#0b1120]/70">{title}</p>
        <PrintButton />
      </div>
      <article className="print-sheet mx-auto bg-white p-[0.7in] text-[#0b1120]" data-attr="print-vendor-payout-receipt">
        <header className="flex items-start justify-between gap-6 border-b border-black/10 pb-6">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">Payment receipt</p>
            <h1 className="mt-1 text-[30px] font-bold leading-tight tracking-tight">{formatInvoiceMoney(breakdown.grossCents)}</h1>
            <p className="mt-1 text-[14px] text-black/70">
              Paid by {managerName} · {paidDate}
              {invoiceNumber ? ` · Invoice ${invoiceNumber}` : ""}
            </p>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-black/45">PropLane</p>
        </header>

        <dl className="mt-6 divide-y divide-black/10">
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Gross</dt>
            <dd className="text-right text-[15px] font-semibold">{formatInvoiceMoney(breakdown.grossCents)}</dd>
          </div>
          {breakdown.feeCents > 0 ? (
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">{PROPLANE_SERVICE_FEE_LABEL}</dt>
              <dd className="text-right text-[15px] font-semibold">−{formatInvoiceMoney(breakdown.feeCents)}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Net paid to you</dt>
            <dd className="text-right text-[15px] font-semibold">{formatInvoiceMoney(breakdown.netCents)}</dd>
          </div>
          {breakdown.refundedGrossCents > 0 ? (
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Refunded</dt>
              <dd className="text-right text-[15px] font-semibold">{formatInvoiceMoney(breakdown.refundedGrossCents)}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">Status</dt>
            <dd className="text-right text-[15px] font-semibold capitalize">{row.status.replace(/_/g, " ")}</dd>
          </div>
        </dl>

        <p className="mt-8 text-[11px] text-black/45">Payment id {payout.id}</p>
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
