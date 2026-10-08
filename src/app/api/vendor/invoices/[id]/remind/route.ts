import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverVendorPaymentFollowUp } from "@/lib/vendor-work-order-payment-notify.server";
import { buildVendorInvoiceReminderEmail } from "@/lib/vendor-work-order-payment-notify-email";
import { formatInvoiceMoney } from "@/lib/vendor-invoices";
import {
  VENDOR_INVOICE_REMINDABLE_STATUSES,
  VENDOR_INVOICE_REMINDER_COOLDOWN_MS,
  isVendorInvoiceRemindable,
} from "@/lib/vendor-invoice-reminder";

export const runtime = "nodejs";

/**
 * Incoming payments > Send reminder. The invoice is looked up by id AND `vendor_user_id` = the
 * session user, so another vendor's invoice id is a 404 (never a 403 that confirms it exists).
 * The 24 h throttle is claimed with a compare-and-set on `last_reminder_at` before anything is
 * sent, so two quick clicks cannot both go out. The message itself goes through the same
 * delivery path as the work-order `send_reminder` in `/api/vendor/work-orders/payment-notify`.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json({ error: auth.status === 401 ? "Unauthorized." : "Forbidden." }, { status: auth.status });
    }
    const db = createSupabaseServiceRoleClient();

    const { data: invoice, error: readError } = await db
      .from("vendor_invoices")
      .select("id, status, manager_user_id, work_order_id, invoice_number, total_cents, currency, last_reminder_at")
      .eq("id", id)
      .eq("vendor_user_id", auth.userId)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

    if (!isVendorInvoiceRemindable(String(invoice.status))) {
      return NextResponse.json(
        { error: "A reminder can only go out for an approved or scheduled invoice." },
        { status: 409 },
      );
    }

    const previous = typeof invoice.last_reminder_at === "string" ? invoice.last_reminder_at : null;
    const now = Date.now();
    if (previous && now - new Date(previous).getTime() < VENDOR_INVOICE_REMINDER_COOLDOWN_MS) {
      const retryAt = new Date(new Date(previous).getTime() + VENDOR_INVOICE_REMINDER_COOLDOWN_MS).toISOString();
      return NextResponse.json(
        { error: "You already sent a reminder for this invoice in the last 24 hours.", retryAt },
        { status: 429 },
      );
    }

    // Claim the slot first. The update is conditional on the value just read, so a concurrent
    // reminder that won the race leaves this one with no row.
    const claimedAt = new Date(now).toISOString();
    let claim = db
      .from("vendor_invoices")
      .update({ last_reminder_at: claimedAt })
      .eq("id", id)
      .eq("vendor_user_id", auth.userId)
      .in("status", [...VENDOR_INVOICE_REMINDABLE_STATUSES]);
    claim = previous ? claim.eq("last_reminder_at", previous) : claim.is("last_reminder_at", null);
    const { data: claimed, error: claimError } = await claim.select("id").maybeSingle();
    if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
    if (!claimed) {
      return NextResponse.json({ error: "A reminder for this invoice was just sent." }, { status: 429 });
    }

    const releaseClaim = async () => {
      await db
        .from("vendor_invoices")
        .update({ last_reminder_at: previous })
        .eq("id", id)
        .eq("vendor_user_id", auth.userId)
        .eq("last_reminder_at", claimedAt);
    };

    try {
      const authClient = await createSupabaseServerClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", auth.userId).maybeSingle();
      const vendorEmail = (profile?.email ?? user?.email ?? "").trim().toLowerCase();
      const vendorName = (profile?.full_name ?? "").trim();

      let title = "";
      let where: string | null = null;
      let propertyId: string | undefined;
      const workOrderId = typeof invoice.work_order_id === "string" ? invoice.work_order_id : "";
      if (workOrderId) {
        const { data: workOrder } = await db
          .from("portal_work_order_records")
          .select("row_data")
          .eq("id", workOrderId)
          .eq("vendor_user_id", auth.userId)
          .maybeSingle();
        const row = (workOrder?.row_data ?? {}) as {
          title?: string;
          propertyName?: string;
          unit?: string;
          propertyId?: string;
          assignedPropertyId?: string;
        };
        title = row.title?.trim() ?? "";
        const unit = row.unit?.trim();
        where = row.propertyName ? (unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName) : null;
        propertyId = String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || undefined;
      }

      const { subject, text } = buildVendorInvoiceReminderEmail({
        vendorName,
        title: title || (invoice.invoice_number as string | null) || "Invoice",
        invoiceNumber: invoice.invoice_number as string | null,
        where,
        amountLabel: formatInvoiceMoney(Number(invoice.total_cents ?? 0), String(invoice.currency ?? "usd")),
      });

      const result = await deliverVendorPaymentFollowUp(db, {
        ownerManagerUserId: (invoice.manager_user_id as string | null) ?? null,
        propertyId,
        vendorUserId: auth.userId,
        vendorEmail,
        vendorName,
        subject,
        text,
      });
      if (!result.ok) {
        await releaseClaim();
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      track("vendor_invoice_reminder_sent", auth.userId, { invoice_id: id, recipient_count: result.recipientCount });
      return NextResponse.json({ ok: true, recipientCount: result.recipientCount, sentAt: claimedAt });
    } catch (error) {
      await releaseClaim();
      throw error;
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not send the reminder." }, { status: 500 });
  }
}
