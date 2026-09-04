import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  declineWorkOrderVendorOffer,
  sendWorkOrderVendorOffers,
  vendorDirectoryRowsById,
} from "@/lib/work-order-offers.server";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** `withdrawn` is the manager pulling the offer back; `declined` is the vendor answering it. */
type OfferStatus = "sent" | "withdrawn" | "declined";

type OfferRecord = {
  id: string;
  work_order_id: string;
  vendor_directory_id: string;
  vendor_user_id: string | null;
  manager_user_id: string;
  status: OfferStatus;
  declined_reason: string | null;
  created_at: string;
  updated_at: string;
};

type OfferJson = {
  id: string;
  workOrderId: string;
  vendorDirectoryId: string;
  vendorUserId: string | null;
  vendorName?: string;
  vendorEmail?: string;
  status: OfferStatus;
  /** Why the vendor said no, when they gave a reason. Vendor-entered — display as data. */
  declinedReason?: string | null;
  createdAt: string;
};

async function sessionActor(db: Db) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  const admin = await isAdminUser(user.id);
  const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  return {
    userId: user.id,
    email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    fullName: profile?.full_name?.trim() || "",
    admin,
    role,
  };
}

function toJson(offer: OfferRecord, vendors: Map<string, { name: string; email: string }>): OfferJson {
  const vendor = vendors.get(offer.vendor_directory_id);
  return {
    id: offer.id,
    workOrderId: offer.work_order_id,
    vendorDirectoryId: offer.vendor_directory_id,
    vendorUserId: offer.vendor_user_id,
    vendorName: vendor?.name,
    vendorEmail: vendor?.email,
    status: offer.status,
    declinedReason: offer.declined_reason ?? null,
    createdAt: offer.created_at,
  };
}

export async function GET(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const workOrderId = url.searchParams.get("workOrderId")?.trim();

    let query = db.from("work_order_vendor_offers").select("*").order("created_at", { ascending: true });
    if (!actor.admin && actor.role === "vendor") {
      const { data: vendorDirectoryRows } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", actor.userId);
      const vendorDirectoryIds = (vendorDirectoryRows ?? []).map((row) => String(row.id ?? "")).filter(Boolean);
      const filters = [`vendor_user_id.eq.${actor.userId}`, ...vendorDirectoryIds.map((id) => `vendor_directory_id.eq.${id}`)];
      query = query.or(filters.join(","));
    } else if (!actor.admin) {
      query = query.eq("manager_user_id", actor.userId);
    }
    if (workOrderId) query = query.eq("work_order_id", workOrderId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const offers = (data ?? []) as OfferRecord[];
    const vendors = await vendorDirectoryRowsById(db, offers.map((o) => o.vendor_directory_id));
    return NextResponse.json({ offers: offers.map((o) => toJson(o, vendors)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load vendor offers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * The manager's confirm-send action: only this route ever offers a work order
 * to a vendor for consultation — nothing is sent automatically. Delegates to
 * sendWorkOrderVendorOffers (work-order-offers.server.ts), the single shared
 * offer + notify + open-bidding implementation.
 */
export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      workOrderId?: string;
      vendorIds?: string[];
      offerId?: string;
      reason?: string;
    };

    // One route, two verbs: a vendor declining an offer is an answer to the manager's send,
    // and keeping it here means both sides read the same ownership rules.
    if (typeof (body as { action?: string }).action === "string" && (body as { action?: string }).action === "decline") {
      const declined = await declineWorkOrderVendorOffer(db, actor, body as { offerId?: string; reason?: string });
      if (!declined.ok) return NextResponse.json({ error: declined.error }, { status: declined.status });
      return NextResponse.json({ ok: true });
    }

    const result = await sendWorkOrderVendorOffers(db, actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, sent: result.sent, skipped: result.skipped });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to send to vendors.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
