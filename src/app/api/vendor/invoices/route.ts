import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { track } from "@/lib/analytics/posthog";
import { resolveVendorLinkedManagers } from "@/lib/vendor-own-record";
import { mapVendorInvoiceRow, VENDOR_INVOICE_SELECT } from "@/lib/vendor-invoices";
import {
  insertVendorInvoiceRow,
  prepareVendorInvoiceSubmission,
  VENDOR_INVOICE_SUBMIT_ERROR_STATUS,
  VendorInvoiceSubmitError,
} from "@/lib/vendor-invoice-submit.server";

export const runtime = "nodejs";

async function requireVendor(): Promise<
  | { ok: true; userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; status: number; error: string }
> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Unauthorized." };
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (String(profile?.role ?? "").toLowerCase() !== "vendor") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  return { ok: true, userId: user.id, db };
}

/** Returns the signed-in vendor's own invoices, most recent first. */
export async function GET() {
  try {
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { data, error } = await gate.db
      .from("vendor_invoices")
      .select(VENDOR_INVOICE_SELECT)
      .eq("vendor_user_id", gate.userId)
      .order("submitted_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // The submit form needs to know WHO it may bill: a vendor linked to more than one manager
    // must choose, and without the list the POST's `multiple_managers` refusal was unreachable
    // to satisfy — which permanently blocked every contractor serving two clients.
    const managers = await resolveVendorLinkedManagers(gate.db, gate.userId);
    return NextResponse.json({ invoices: (data ?? []).map(mapVendorInvoiceRow), managers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load invoices.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Vendor submits a new invoice to one of the managers they're linked to. */
export async function POST(req: Request) {
  try {
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const { db, userId } = gate;

    const body = (await req.json()) as {
      managerUserId?: string;
      workOrderId?: string;
      invoiceNumber?: string;
      lineItems?: unknown;
      taxCents?: number;
      memo?: string;
    };

    // Shared validation with the submit_vendor_invoice agent tool: resolves
    // which manager this vendor may bill, verifies any supplied work order
    // belongs to that manager and this vendor, and recomputes the total from
    // the line items — never trusting client-supplied ids or amounts.
    let prepared;
    try {
      prepared = await prepareVendorInvoiceSubmission(db, userId, body);
    } catch (e) {
      if (e instanceof VendorInvoiceSubmitError) {
        return NextResponse.json(
          { error: e.message },
          { status: VENDOR_INVOICE_SUBMIT_ERROR_STATUS[e.code] },
        );
      }
      throw e;
    }

    const now = new Date().toISOString();
    const { data, error } = await insertVendorInvoiceRow(db, prepared, {
      vendorUserId: userId,
      invoiceNumber: body.invoiceNumber,
      memo: body.memo,
      now,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Server-confirmed outcome — fire only after the row is written.
    track("vendor_invoice_submitted", userId, {
      invoice_id: data.id as string,
      total_cents: prepared.totalCents,
      line_items: prepared.lineItems.length,
      has_work_order: Boolean(prepared.workOrderId),
    });

    return NextResponse.json({ invoice: mapVendorInvoiceRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to submit invoice.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
