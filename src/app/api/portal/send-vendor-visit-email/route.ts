import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendVendorNotification } from "@/lib/vendor-notification-delivery";
import { buildVendorBidOfferEmail, buildVendorVisitEmail } from "@/lib/vendor-visit-email";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("role, email, full_name").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    if (!admin && role !== "manager" && role !== "pro") {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      kind?: "visit" | "bid_offer";
      workOrderId?: string;
      vendorId?: string;
      vendorEmail?: string;
      vendorName?: string;
      workOrderTitle?: string;
      propertyLabel?: string;
      unit?: string;
      visitLabel?: string;
      description?: string;
      preferredArrival?: string;
    };
    const kind = body.kind === "bid_offer" ? "bid_offer" : "visit";

    const workOrderId = String(body.workOrderId ?? "").trim();
    if (!workOrderId) {
      return NextResponse.json({ ok: false, error: "Work order id required." }, { status: 400 });
    }
    if (!admin) {
      const { data: workOrder } = await db
        .from("portal_work_order_records")
        .select("manager_user_id")
        .eq("id", workOrderId)
        .maybeSingle();
      if (!workOrder || workOrder.manager_user_id !== user.id) {
        return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
      }
    }

    const vendorEmail = String(body.vendorEmail ?? "").trim().toLowerCase();
    const vendorName = String(body.vendorName ?? "").trim();
    const workOrderTitle = String(body.workOrderTitle ?? "").trim();
    const propertyLabel = String(body.propertyLabel ?? "").trim();
    const unit = String(body.unit ?? "").trim();
    const visitLabel = String(body.visitLabel ?? "").trim();
    const description = String(body.description ?? "").trim();
    const preferredArrival = String(body.preferredArrival ?? "").trim();

    if (!vendorEmail.includes("@")) {
      return NextResponse.json({ ok: false, error: "Valid vendor email required." }, { status: 400 });
    }
    if (!workOrderTitle || (kind === "visit" && !visitLabel)) {
      return NextResponse.json({ ok: false, error: "Work order title and visit time required." }, { status: 400 });
    }

    const { subject, body: messageBody } =
      kind === "bid_offer"
        ? buildVendorBidOfferEmail({ vendorName, workOrderTitle, propertyLabel, unit, visitLabel, description })
        : buildVendorVisitEmail({ vendorName, workOrderTitle, propertyLabel, unit, visitLabel, description, preferredArrival });

    const vendorId = String(body.vendorId ?? "").trim();
    const { emailSent, inboxDelivered, skippedDemoEmail } = await sendVendorNotification(
      db,
      { userId: user.id, email: (profile?.email ?? user.email ?? "").trim().toLowerCase(), fullName: profile?.full_name?.trim() || "" },
      { vendorEmail, vendorDirectoryId: vendorId || null, subject, body: messageBody, topic: kind === "bid_offer" ? "offers" : "schedule" },
    );

    track(kind === "bid_offer" ? "work_order_bid_offer_sent" : "work_order_vendor_email_sent", user.id, {
      email_sent: emailSent,
      inbox_delivered: inboxDelivered,
    });
    return NextResponse.json({ ok: true, emailSent, inboxDelivered, skipped: skippedDemoEmail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
