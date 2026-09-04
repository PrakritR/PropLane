import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  acceptWorkOrderBid,
  scheduleWorkOrderConsultation,
  submitWorkOrderBid,
  withdrawWorkOrderBid,
  vendorNamesById,
  type BidRecord,
  type QuoteMode,
} from "@/lib/work-order-bids.server";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

type BidJson = {
  id: string;
  workOrderId: string;
  vendorUserId: string;
  vendorDirectoryId: string | null;
  vendorName?: string;
  vendorEmail?: string;
  quoteMode: QuoteMode;
  consultationVisitAt: string | null;
  amountCents: number | null;
  materialsCents: number;
  proposedTime: string | null;
  note: string | null;
  status: "submitted" | "accepted" | "declined";
  createdAt: string;
  updatedAt: string;
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

function toJson(bid: BidRecord, vendors: Map<string, { name: string; email: string }>): BidJson {
  const vendor = bid.vendor_directory_id ? vendors.get(bid.vendor_directory_id) : undefined;
  return {
    id: bid.id,
    workOrderId: bid.work_order_id,
    vendorUserId: bid.vendor_user_id,
    vendorDirectoryId: bid.vendor_directory_id,
    vendorName: vendor?.name,
    vendorEmail: vendor?.email,
    quoteMode: bid.quote_mode,
    consultationVisitAt: bid.consultation_visit_at,
    amountCents: bid.amount_cents,
    materialsCents: bid.materials_cents,
    proposedTime: bid.proposed_time,
    note: bid.note,
    status: bid.status,
    createdAt: bid.created_at,
    updatedAt: bid.updated_at,
  };
}

export async function GET(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const workOrderId = url.searchParams.get("workOrderId")?.trim();

    let query = db.from("work_order_bids").select("*").order("amount_cents", { ascending: true });
    if (!actor.admin && actor.role === "vendor") {
      query = query.eq("vendor_user_id", actor.userId);
    } else if (!actor.admin) {
      query = query.eq("manager_user_id", actor.userId);
    }
    if (workOrderId) query = query.eq("work_order_id", workOrderId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const bids = (data ?? []) as BidRecord[];
    const vendors = await vendorNamesById(db, bids.map((b) => b.vendor_directory_id ?? ""));
    return NextResponse.json({ bids: bids.map((b) => toJson(b, vendors)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load bids.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      action?: "submit" | "accept" | "schedule_consultation" | "withdraw";
      workOrderId?: string;
      amountCents?: number;
      materialsCents?: number;
      proposedTime?: string;
      note?: string;
      bidId?: string;
      mode?: "auto" | "manual";
      consultationVisitAt?: string;
    };

    if (body.action === "accept") {
      const result = await acceptWorkOrderBid(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "submit") {
      const result = await submitWorkOrderBid(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "schedule_consultation") {
      const result = await scheduleWorkOrderConsultation(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, consultationVisitAt: result.consultationVisitAt });
    }
    if (body.action === "withdraw") {
      const result = await withdrawWorkOrderBid(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save bid.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
