import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverVendorWorkOrderPaymentNotify } from "@/lib/vendor-work-order-payment-notify.server";
import type { VendorWorkOrderPaymentNotifyKind } from "@/lib/vendor-work-order-payment-notify-email";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

type Actor = { userId: string; email: string; fullName: string; admin: boolean };

/**
 * The vendor chasing their own payment, authorized off `profile_roles` - `profiles.role` alone
 * reads a manager+vendor account as "manager" forever and 403'd it out of its own payments.
 * A platform admin keeps the same allowance it had.
 */
async function sessionActor(db: Db): Promise<{ actor: Actor } | { status: 401 | 403 }> {
  const access = await requireVendorApiAccess();
  if (access.ok) {
    const { userId, email, fullName, admin } = access.actor;
    return { actor: { userId, email, fullName, admin } };
  }
  if (access.status === 401) return { status: 401 };
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { status: 401 };
  if (!(await isAdminUser(user.id))) return { status: 403 };
  const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", user.id).maybeSingle();
  return {
    actor: {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      fullName: profile?.full_name?.trim() || "",
      admin: true,
    },
  };
}

/** Vendor payment follow-up — email + Axis inbox to the work order's manager, co-managers, and offer sender. */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const resolved = await sessionActor(db);
    if ("status" in resolved) {
      return NextResponse.json(
        { error: resolved.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: resolved.status },
      );
    }
    const actor = resolved.actor;

    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      action?: VendorWorkOrderPaymentNotifyKind;
    };
    const workOrderId = String(body.workOrderId ?? "").trim();
    const action = body.action;
    if (!workOrderId) return NextResponse.json({ error: "Work order id required." }, { status: 400 });
    if (action !== "send_reminder" && action !== "report_paid") {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }

    const result = await deliverVendorWorkOrderPaymentNotify(db, {
      workOrderId,
      vendorUserId: actor.userId,
      vendorEmail: actor.email,
      vendorName: actor.fullName,
      kind: action,
    });
    if (!result.ok) {
      const status = result.error === "Forbidden." ? 403 : result.error === "Work order not found." ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    track(
      action === "send_reminder" ? "vendor_work_order_payment_reminder_sent" : "vendor_work_order_payment_reported",
      actor.userId,
      { work_order_id: workOrderId, recipient_count: result.recipientCount },
    );
    return NextResponse.json({ ok: true, recipientCount: result.recipientCount });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not send notification.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
