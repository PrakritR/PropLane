import { resolveActiveWorkspaceRowScope, rowAllowedInWorkspaceScope } from "@/lib/workspaces/row-scope.server";
import { invoiceBelongsInOutgoing, outgoingInvoiceTotals } from "@/lib/manager-outgoing-invoices";
import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { mapVendorInvoiceRow, VENDOR_INVOICE_STATUSES, type VendorInvoiceStatus } from "@/lib/vendor-invoices";

export const runtime = "nodejs";

async function allRows<T>(query: { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query.range(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 500) return rows;
  }
}


/** Extra columns beyond `VENDOR_INVOICE_SELECT` this manager-facing list needs to pay or attribute a row. */
const MANAGER_VENDOR_INVOICE_SELECT =
  "id, vendor_id, vendor_user_id, work_order_id, invoice_number, line_items, subtotal_cents, tax_cents, total_cents, currency, status, memo, decision_note, bill_id, submitted_at, decided_at, paid_at, paid_from, created_at, scheduled_for, offline_method, manager_entered, voided_at";

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
    if (url.searchParams.get("choices") === "1") {
      const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
      const services = await allRows(auth.db.from("portal_work_order_records").select("id,vendor_user_id,property_id,row_data").eq("manager_user_id", auth.userId).not("vendor_user_id", "is", null).order("id", { ascending: true }));
      return NextResponse.json({ services: services.filter(service => rowAllowedInWorkspaceScope(scope, service.property_id)).map(service => ({ id: service.id, vendorUserId: service.vendor_user_id, title: (service.row_data as { title?: string })?.title || "Service" })) });
    }
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
      .order("submitted_at", { ascending: false }).order("id", { ascending: true });
    if (vendorUserId) query = query.eq("vendor_user_id", vendorUserId);

    const rows = (await allRows(query)).filter(row => !row.voided_at);

    const vendorUserIds = [...new Set(rows.map((row) => String(row.vendor_user_id ?? "")).filter(Boolean))];
    const namesById = new Map<string, string>();
    if (vendorUserIds.length > 0) {
      const profiles = await allRows(auth.db.from("profiles").select("id, full_name").in("id", vendorUserIds).order("id", { ascending: true }));
      for (const profile of profiles ?? []) {
        namesById.set(String(profile.id), String(profile.full_name ?? "").trim() || "Vendor");
      }
    }

    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    const workIds = [...new Set(rows.map((row) => row.work_order_id).filter(Boolean))];
    const services = new Map<string, { vendorUserId: string | null; title: string; propertyName: string; propertyId: string | null }>();
    if (workIds.length) {
      const workRows = await allRows(auth.db.from("portal_work_order_records")
        .select("id, vendor_user_id, property_id, row_data").eq("manager_user_id", auth.userId).in("id", workIds).order("id", { ascending: true }));
      for (const work of workRows ?? []) {
        const detail = work.row_data as { title?: string; propertyName?: string } | null;
        services.set(String(work.id), { vendorUserId: work.vendor_user_id, propertyId: work.property_id, title: detail?.title ?? "Service", propertyName: detail?.propertyName ?? "" });
      }
    }
    const invoices = rows.map((row) => ({
      ...mapVendorInvoiceRow(row),
      serviceTitle: services.get(String(row.work_order_id))?.title,
      propertyName: services.get(String(row.work_order_id))?.propertyName,
      vendorUserId: String(row.vendor_user_id ?? ""),
      vendorName: namesById.get(String(row.vendor_user_id ?? "")) ?? "Vendor",
    }));

    const outgoing = invoices.filter((invoice) => (!invoice.workOrderId || services.has(invoice.workOrderId)) && rowAllowedInWorkspaceScope(scope, services.get(invoice.workOrderId ?? "")?.propertyId) && invoiceBelongsInOutgoing(invoice, services.get(invoice.workOrderId ?? "")?.vendorUserId ?? null));
    const result = url.searchParams.get("outgoing") === "1" ? outgoing : invoices;
    const totals = outgoingInvoiceTotals(outgoing, new Date().getUTCFullYear());
    const payoutRows: Array<{ id: string; vendorUserId: string; vendorName: string; workOrderId: string | null; amountCents: number; createdAt: string }> = [];
    if (url.searchParams.get("outgoing") === "1") {
      let payoutQuery = auth.db.from("vendor_payouts").select("id, vendor_user_id, work_order_id, invoice_id, amount_cents, created_at, updated_at")
        .eq("manager_user_id", auth.userId).eq("status", "paid").order("id", { ascending: true });
      if (vendorUserId) payoutQuery = payoutQuery.eq("vendor_user_id", vendorUserId);
      const payouts = await allRows(payoutQuery);
      const invoiceIds = new Set(invoices.map(invoice => invoice.id));
      const unmatched = (payouts ?? []).filter(payout => !invoiceIds.has(payout.invoice_id));
      const payoutVendorIds = [...new Set(unmatched.map(payout => payout.vendor_user_id).filter(id => !namesById.has(id)))];
      if (payoutVendorIds.length) {
        const profiles = await allRows(auth.db.from("profiles").select("id, full_name").in("id", payoutVendorIds).order("id", { ascending: true }));
        for (const profile of profiles) namesById.set(profile.id, profile.full_name?.trim() || "Vendor");
      }
      const missingWorkIds = [...new Set(unmatched.map(payout => payout.work_order_id).filter(Boolean))];
      const payoutProperties = new Map<string, string | null>();
      if (missingWorkIds.length) {
        const work = await allRows(auth.db.from("portal_work_order_records").select("id, property_id").eq("manager_user_id", auth.userId).in("id", missingWorkIds).order("id", { ascending: true }));
        for (const item of work ?? []) payoutProperties.set(item.id, item.property_id);
      }
      for (const payout of unmatched) {
        if (payout.work_order_id && !payoutProperties.has(payout.work_order_id)) continue;
        if (!rowAllowedInWorkspaceScope(scope, payoutProperties.get(payout.work_order_id))) continue;
        payoutRows.push({ id: payout.id, vendorUserId: payout.vendor_user_id, vendorName: namesById.get(payout.vendor_user_id) ?? "Vendor", workOrderId: payout.work_order_id, amountCents: payout.amount_cents, createdAt: payout.updated_at ?? payout.created_at });
        if (String(payout.updated_at ?? payout.created_at).slice(0, 4) === String(new Date().getUTCFullYear())) {
          if (!Number.isSafeInteger(payout.amount_cents) || payout.amount_cents < 0 || !Number.isSafeInteger(totals.paidThisYearCents + payout.amount_cents)) throw new Error("Invalid payout amount.");
          totals.paidThisYearCents += payout.amount_cents;
        }
      }
    }
    return NextResponse.json({ invoices: result, payouts: payoutRows, totals }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load vendor invoices.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Manager-entered bills still require a service assigned to the billed vendor. */
export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const body = await req.json() as { id?: string; workOrderId?: string; title?: string; amountCents?: number };
    if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !body.title?.trim() || !Number.isSafeInteger(body.amountCents) || Number(body.amountCents) < 100) return NextResponse.json({ error: "Enter a service, description and amount of at least $1." }, { status: 400 });
    const { data: service, error } = await auth.db.from("portal_work_order_records").select("id, vendor_user_id, property_id").eq("id", body.workOrderId).eq("manager_user_id", auth.userId).maybeSingle();
    if (error) throw new Error(error.message);
    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    if (!service?.vendor_user_id || !rowAllowedInWorkspaceScope(scope, service.property_id)) return NextResponse.json({ error: "Choose an assigned service in this workspace." }, { status: 400 });
    const { data: vendor } = await auth.db.from("manager_vendor_records").select("id").eq("manager_user_id", auth.userId).eq("vendor_user_id", service.vendor_user_id).limit(1).maybeSingle();
    if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    const { error: createError } = await auth.db.from("vendor_invoices").insert({ id: body.id, manager_user_id: auth.userId, vendor_user_id: service.vendor_user_id, vendor_id: vendor.id, work_order_id: service.id, total_cents: body.amountCents, subtotal_cents: body.amountCents, tax_cents: 0, line_items: [{ description: body.title.trim(), quantity: 1, unitAmountCents: body.amountCents, amountCents: body.amountCents }], status: "approved", memo: body.title.trim(), manager_entered: true });
    if (createError) {
      if (createError.code !== "23505") throw new Error(createError.message);
      const { data: prior } = await auth.db.from("vendor_invoices").select("manager_user_id,work_order_id,total_cents").eq("id", body.id).maybeSingle();
      if (!prior || prior.manager_user_id !== auth.userId || prior.work_order_id !== service.id || prior.total_cents !== body.amountCents) throw new Error("Bill id already used.");
    }
    const { createBillFromVendorInvoice } = await import("@/lib/manager-bills.server");
    await createBillFromVendorInvoice(auth.db, auth.userId, body.id);
    return NextResponse.json({ id: body.id });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create bill." }, { status: 400 }); }
}
