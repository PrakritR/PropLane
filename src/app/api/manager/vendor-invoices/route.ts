import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { mapVendorInvoiceRow, VENDOR_INVOICE_STATUSES, type VendorInvoiceStatus } from "@/lib/vendor-invoices";

export const runtime = "nodejs";

/** Extra columns beyond `VENDOR_INVOICE_SELECT` this manager-facing list needs to pay or attribute a row. */
const MANAGER_VENDOR_INVOICE_SELECT =
  "id, vendor_id, vendor_user_id, work_order_id, invoice_number, line_items, subtotal_cents, tax_cents, total_cents, currency, status, memo, decision_note, bill_id, submitted_at, decided_at, paid_at, paid_from, created_at";

/**
 * Vendor invoices billed to the signed-in manager — the manager-facing twin
 * of `GET /api/vendor/invoices` (that one lists a vendor's own submissions;
 * this one lists what a manager owes across every vendor that has billed
 * them). Powers the Financials "Pay vendors" card and the Vendors page's
 * per-vendor invoice list (C042/C081/C260) — no manager-facing invoice list
 * existed before this route (see docs/agents/vendor-invoicing.md).
 *
 * `status` (repeatable or comma-separated) narrows the list; default is
 * `approved,scheduled` — the two states "Pay from balance" can act on.
 * `vendorUserId` narrows to one vendor (the Vendors page's per-vendor view).
 */
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const vendorUserId = url.searchParams.get("vendorUserId")?.trim() || null;
    const statusParam = url.searchParams.getAll("status").flatMap((s) => s.split(","));
    const statuses = (statusParam.length > 0 ? statusParam : ["approved", "scheduled"])
      .map((s) => s.trim())
      .filter((s): s is VendorInvoiceStatus => (VENDOR_INVOICE_STATUSES as readonly string[]).includes(s));
    if (statuses.length === 0) return NextResponse.json({ error: "Invalid status filter." }, { status: 400 });

    let query = auth.db
      .from("vendor_invoices")
      .select(MANAGER_VENDOR_INVOICE_SELECT)
      .eq("manager_user_id", auth.userId)
      .in("status", statuses)
      .order("submitted_at", { ascending: false });
    if (vendorUserId) query = query.eq("vendor_user_id", vendorUserId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = data ?? [];

    const vendorUserIds = [...new Set(rows.map((row) => String(row.vendor_user_id ?? "")).filter(Boolean))];
    const namesById = new Map<string, string>();
    if (vendorUserIds.length > 0) {
      const { data: profiles } = await auth.db.from("profiles").select("id, full_name").in("id", vendorUserIds);
      for (const profile of profiles ?? []) {
        namesById.set(String(profile.id), String(profile.full_name ?? "").trim() || "Vendor");
      }
    }

    const invoices = rows.map((row) => ({
      ...mapVendorInvoiceRow(row),
      vendorUserId: String(row.vendor_user_id ?? ""),
      vendorName: namesById.get(String(row.vendor_user_id ?? "")) ?? "Vendor",
    }));

    return NextResponse.json({ invoices }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load vendor invoices.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
