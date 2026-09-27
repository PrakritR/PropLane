import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { canActForVendorReviewWorkspace } from "@/lib/vendor-review-write-access.server";
import {
  computeVendorReviewAggregate,
  evaluateVendorReviewEligibility,
  mapVendorReviewRow,
  normalizeVendorReviewBody,
  normalizeVendorReviewStars,
  redactVendorReviewForViewer,
  VENDOR_REVIEW_SELECT,
} from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * GET ?vendorUserId=<id> — every review of that vendor across every
 * workspace, aggregate + redacted list (manager side of the vendor's record
 * page and the vendors list).
 * GET ?workOrderId=<id> — this actor's own workspace's review of that one
 * completed service, if any (used to show Edit vs. Leave a review).
 */
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const url = new URL(req.url);
    const vendorUserId = url.searchParams.get("vendorUserId")?.trim();
    const workOrderId = url.searchParams.get("workOrderId")?.trim();

    if (workOrderId) {
      const { data: workOrder, error: workOrderError } = await auth.db
        .from("portal_work_order_records")
        .select("manager_user_id, property_id, assigned_property_id")
        .eq("id", workOrderId)
        .maybeSingle();
      if (workOrderError) return NextResponse.json({ error: workOrderError.message }, { status: 500 });
      if (!workOrder) return NextResponse.json({ error: "Service not found." }, { status: 404 });
      const ownerManagerUserId = String(workOrder.manager_user_id ?? "");
      const allowed =
        auth.role === "admin" ||
        (await canActForVendorReviewWorkspace(
          auth.db,
          auth.userId,
          ownerManagerUserId,
          (workOrder.assigned_property_id as string | null) ?? (workOrder.property_id as string | null),
        ));
      if (!allowed) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

      const { data, error } = await auth.db
        .from("vendor_reviews")
        .select(VENDOR_REVIEW_SELECT)
        .eq("work_order_id", workOrderId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ review: data ? mapVendorReviewRow(data) : null });
    }

    if (!vendorUserId) {
      return NextResponse.json({ error: "vendorUserId or workOrderId required." }, { status: 400 });
    }

    const { data, error } = await auth.db
      .from("vendor_reviews")
      .select(VENDOR_REVIEW_SELECT)
      .eq("vendor_user_id", vendorUserId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const reviews = (data ?? []).map(mapVendorReviewRow);
    const aggregate = computeVendorReviewAggregate(reviews.map((r) => r.stars));
    const redacted = reviews.map((review) => redactVendorReviewForViewer(review, auth.userId));
    return NextResponse.json({ reviews: redacted, aggregate });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load reviews.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Manager (or a co-manager with the `services` edit permission) reviews a completed service. */
export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const body = (await req.json()) as { workOrderId?: string; stars?: number; body?: string };
    const workOrderId = body.workOrderId?.trim();
    if (!workOrderId) return NextResponse.json({ error: "workOrderId required." }, { status: 400 });

    const stars = normalizeVendorReviewStars(body.stars);
    if (stars == null) return NextResponse.json({ error: "Rating must be 1 to 5 stars." }, { status: 400 });
    const reviewBody = normalizeVendorReviewBody(body.body);

    const { data: workOrder, error: workOrderError } = await auth.db
      .from("portal_work_order_records")
      .select("manager_user_id, vendor_user_id, row_data, property_id, assigned_property_id")
      .eq("id", workOrderId)
      .maybeSingle();
    if (workOrderError) return NextResponse.json({ error: workOrderError.message }, { status: 500 });
    if (!workOrder) return NextResponse.json({ error: "Service not found." }, { status: 404 });

    const ownerManagerUserId = String(workOrder.manager_user_id ?? "");
    const allowed =
      auth.role === "admin" ||
      (await canActForVendorReviewWorkspace(
        auth.db,
        auth.userId,
        ownerManagerUserId,
        (workOrder.assigned_property_id as string | null) ?? (workOrder.property_id as string | null),
      ));
    if (!allowed) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

    const rowData = (workOrder.row_data ?? {}) as Record<string, unknown>;
    const eligibility = evaluateVendorReviewEligibility({
      workOrderBucket: (rowData.bucket as string | undefined) ?? null,
      workOrderManagerUserId: ownerManagerUserId,
      workOrderVendorUserId: (workOrder.vendor_user_id as string | null) ?? null,
      actorManagerUserId: ownerManagerUserId,
    });
    if (!eligibility.ok) {
      return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
    }

    const now = new Date().toISOString();
    const { data, error } = await auth.db
      .from("vendor_reviews")
      .insert({
        manager_user_id: ownerManagerUserId,
        reviewer_user_id: auth.userId,
        vendor_user_id: eligibility.vendorUserId,
        work_order_id: workOrderId,
        stars,
        body: reviewBody,
        created_at: now,
        updated_at: now,
      })
      .select(VENDOR_REVIEW_SELECT)
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A review already exists for this service." }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ review: mapVendorReviewRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save review.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
