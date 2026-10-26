import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { csvMoneyFromCents, toCsv } from "@/lib/csv";
import { mapVendorInvoiceRow, VENDOR_INVOICE_SELECT } from "@/lib/vendor-invoices";

export const runtime = "nodejs";

/**
 * CSV export of a vendor's own invoices or payouts, over a date range.
 *
 * A 1099 contractor needs their year's figures every January, and until this existed the
 * answer was to screenshot a web page. Both datasets are scoped to the signed-in vendor;
 * neither takes an id or an owner from the request.
 */

const DATASETS = new Set(["invoices", "payouts"]);

/** An ISO date (YYYY-MM-DD) or full timestamp, or null. Anything else is ignored, not guessed. */
function isoBound(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) return null;
  return trimmed.length === 10 ? trimmed : trimmed;
}

export async function GET(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }
    const user = { id: access.actor.userId };
    const db = createSupabaseServiceRoleClient();

    const { searchParams } = new URL(req.url);
    const dataset = (searchParams.get("dataset") ?? "invoices").toLowerCase();
    if (!DATASETS.has(dataset)) {
      return NextResponse.json({ error: "Unknown export." }, { status: 400 });
    }
    // An unparseable bound widens the range rather than narrowing it: a silently dropped
    // filter that returns MORE of the vendor's own rows is a nuisance, while one that returns
    // fewer would quietly under-report their year.
    const from = isoBound(searchParams.get("from"));
    const to = isoBound(searchParams.get("to"));

    const stamp = new Date().toISOString().slice(0, 10);
    const csv =
      dataset === "invoices"
        ? await invoicesCsv(db, user.id, from, to)
        : await payoutsCsv(db, user.id, from, to);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="proplane-${dataset}-${stamp}.csv"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to export.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function invoicesCsv(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  vendorUserId: string,
  from: string | null,
  to: string | null,
): Promise<string> {
  let query = db
    .from("vendor_invoices")
    .select(VENDOR_INVOICE_SELECT)
    .eq("vendor_user_id", vendorUserId)
    .order("submitted_at", { ascending: true });
  if (from) query = query.gte("submitted_at", from);
  if (to) query = query.lte("submitted_at", to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return toCsv(
    ["Submitted", "Invoice #", "Service", "Status", "Subtotal", "Tax", "Total", "Currency", "Decided", "Paid", "Memo"],
    (data ?? []).map(mapVendorInvoiceRow).map((inv) => [
      inv.submittedAt,
      inv.invoiceNumber,
      inv.workOrderId,
      inv.status,
      csvMoneyFromCents(inv.subtotalCents),
      csvMoneyFromCents(inv.taxCents),
      csvMoneyFromCents(inv.totalCents),
      inv.currency.toUpperCase(),
      inv.decidedAt,
      inv.paidAt,
      inv.memo,
    ]),
  );
}

async function payoutsCsv(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  vendorUserId: string,
  from: string | null,
  to: string | null,
): Promise<string> {
  let query = db
    .from("vendor_payouts")
    .select("id, work_order_id, amount_cents, stripe_transfer_id, status, failure_reason, created_at")
    .eq("vendor_user_id", vendorUserId)
    .order("created_at", { ascending: true });
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return toCsv(
    ["Date", "Service", "Amount", "Status", "Stripe transfer", "Failure reason"],
    (data ?? []).map((row) => [
      row.created_at,
      row.work_order_id,
      csvMoneyFromCents(Number(row.amount_cents ?? 0)),
      row.status,
      row.stripe_transfer_id,
      row.failure_reason,
    ]),
  );
}
