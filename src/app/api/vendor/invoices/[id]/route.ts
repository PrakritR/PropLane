import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  mapVendorInvoiceRow,
  normalizeLineItems,
  sumLineItemsCents,
  VENDOR_INVOICE_SELECT,
  type VendorInvoiceStatus,
} from "@/lib/vendor-invoices";

export const runtime = "nodejs";

/**
 * A vendor's own corrections to an invoice they have not had reviewed yet.
 *
 * The vendor is SELECT-only on `vendor_invoices` at the database layer, and deliberately so —
 * a public-client UPDATE could flip `status` or `total_cents`. That left no way to fix a
 * typo either: the vendor had to ask the manager to reject the invoice and then send a
 * duplicate. These handlers are the authorized path, and they exist only while the invoice is
 * still `submitted`; once a manager has acted on it, it is evidence in their books.
 */

type VendorGate =
  | { ok: true; userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; status: number; error: string };

async function requireVendor(): Promise<VendorGate> {
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

/**
 * The invoice, if it is this vendor's AND still theirs to change.
 *
 * Scoped on `vendor_user_id` rather than the id alone, so another vendor's invoice reads as
 * missing rather than forbidden — the id is supplied by the client and must never select a
 * row on its own.
 */
async function loadEditableInvoice(gate: Extract<VendorGate, { ok: true }>, id: string) {
  const { data, error } = await gate.db
    .from("vendor_invoices")
    .select("id, status, bill_id")
    .eq("id", id)
    .eq("vendor_user_id", gate.userId)
    .maybeSingle();
  if (error) return { ok: false as const, status: 500, error: error.message };
  if (!data) return { ok: false as const, status: 404, error: "Invoice not found." };

  const status = data.status as VendorInvoiceStatus;
  if (status !== "submitted") {
    return {
      ok: false as const,
      status: 409,
      error: `This invoice is already ${status}; ask the manager to reject it if it needs to change.`,
    };
  }
  // Belt and braces: an approved invoice creates a manager bill, so a row carrying one is
  // under review no matter what its status column says.
  if (data.bill_id) {
    return { ok: false as const, status: 409, error: "This invoice is already in the manager's bills." };
  }
  return { ok: true as const };
}

/** Vendor corrects a still-unreviewed invoice. Totals are recomputed here, never trusted. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const editable = await loadEditableInvoice(gate, id);
    if (!editable.ok) return NextResponse.json({ error: editable.error }, { status: editable.status });

    const body = (await req.json()) as {
      lineItems?: unknown;
      invoiceNumber?: string | null;
      memo?: string | null;
      taxCents?: number;
    };

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.lineItems !== undefined) {
      const lineItems = normalizeLineItems(body.lineItems);
      if (lineItems.length === 0) {
        return NextResponse.json({ error: "Add at least one line item with an amount." }, { status: 400 });
      }
      // Recomputed from the items, exactly as submission does — a client-supplied total is
      // never written, so a corrected invoice cannot claim an amount its lines do not add to.
      const subtotalCents = sumLineItemsCents(lineItems);
      const taxCents = Number.isFinite(body.taxCents) ? Math.max(0, Math.round(Number(body.taxCents))) : 0;
      patch.line_items = lineItems;
      patch.subtotal_cents = subtotalCents;
      patch.tax_cents = taxCents;
      patch.total_cents = subtotalCents + taxCents;
    }
    if (body.invoiceNumber !== undefined) patch.invoice_number = body.invoiceNumber?.trim() || null;
    if (body.memo !== undefined) patch.memo = body.memo?.trim() || null;

    const { data, error } = await gate.db
      .from("vendor_invoices")
      .update(patch)
      .eq("id", id)
      .eq("vendor_user_id", gate.userId)
      // Re-asserted in the write itself: between the read above and this update a manager
      // could have approved the invoice, and the compare-and-swap is what makes that a no-op
      // rather than an edit to a row already in their books.
      .eq("status", "submitted")
      .select(VENDOR_INVOICE_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      return NextResponse.json({ error: "This invoice was reviewed before your change saved." }, { status: 409 });
    }
    return NextResponse.json({ invoice: mapVendorInvoiceRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update invoice.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Vendor withdraws a still-unreviewed invoice.
 *
 * Deleted rather than moved to a `withdrawn` status: the status column carries a database
 * CHECK constraint, and a new state would also be a state the manager's review UI has never
 * heard of. An invoice no manager has acted on has no downstream references — no bill, no
 * decision, no payout — so removing it leaves nothing dangling. Once reviewed it stays.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const editable = await loadEditableInvoice(gate, id);
    if (!editable.ok) return NextResponse.json({ error: editable.error }, { status: editable.status });

    const { data, error } = await gate.db
      .from("vendor_invoices")
      .delete()
      .eq("id", id)
      .eq("vendor_user_id", gate.userId)
      .eq("status", "submitted")
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      return NextResponse.json({ error: "This invoice was reviewed before it could be withdrawn." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to withdraw invoice.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
