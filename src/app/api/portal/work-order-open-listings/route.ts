import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import {
  browseOpenListings,
  closeWorkOrderBidding,
  getOwnOpenListing,
  openWorkOrderForBidding,
} from "@/lib/work-order-open-listings.server";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

async function sessionActor(db: Db) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
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

/**
 * `?workOrderId=` -> the manager's own listing for that service (any status).
 * No `workOrderId` -> a vendor's paginated, filterable browse of every OPEN
 * listing across every workspace (`?trade=&area=&offset=&limit=`).
 */
export async function GET(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const workOrderId = url.searchParams.get("workOrderId")?.trim();

    if (workOrderId) {
      const result = await getOwnOpenListing(db, actor, workOrderId);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ listing: result.listing });
    }

    const trade = url.searchParams.get("trade")?.trim() || undefined;
    const area = url.searchParams.get("area")?.trim() || undefined;
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const result = await browseOpenListings(db, actor, { trade, area, offset, limit });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ listings: result.listings, hasMore: result.hasMore });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load open listings.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const db = createSupabaseServiceRoleClient();
    const actor = await sessionActor(db);
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      action?: "open" | "close";
      workOrderId?: string;
      trade?: string;
      area?: string;
      description?: string;
      timeframe?: string;
      budgetMinCents?: number | string;
      budgetMaxCents?: number | string;
    };

    if (body.action === "open") {
      const result = await openWorkOrderForBidding(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, listing: result.listing });
    }
    if (body.action === "close") {
      const result = await closeWorkOrderBidding(db, actor, body);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ ok: true, listing: result.listing });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save listing.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
