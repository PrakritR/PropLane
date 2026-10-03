import { NextRequest, NextResponse } from "next/server";
import type { MockProperty } from "@/data/types";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { isPropertyActiveForLeads } from "@/lib/demo-property-pipeline";
import { createLeaseFirstDraft } from "@/lib/leasing/lease-first-draft.server";
import {
  loadLeasingPipelineState,
  resolveLeasingPipelineForProperty,
  signingOrderForPipeline,
} from "@/lib/leasing-pipeline-preferences";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceRequestScope } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const PER_RESIDENT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A prospect pressed "Sign lease" on a lease-first listing. Lease-first has no
 * application to hang the lease on, so the lease starts as the same marker
 * draft "Send lease to sign" creates (`createLeaseFirstDraft`) — the resident's
 * Lease tab then opens on its intake form (room, move-in, term) before any
 * document.
 *
 * Nothing here trusts the body beyond a property id: the property must be a live
 * listing, the workspace order must really be lease-first (the SAME
 * `signingOrderForPipeline` rule the public page used to show "Sign lease"), the
 * resident identity comes from the session, and the draft is idempotent per
 * (manager, property, email), so a double-click or a reload returns the same row.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", user.id).maybeSingle();
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });
    if (!email) return NextResponse.json({ error: "No email on file." }, { status: 400 });

    const body = (await req.json().catch(() => ({}))) as { propertyId?: string; roomChoice?: string };
    const propertyId = (body.propertyId ?? "").trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });

    const limit = await rateLimit(`lease-first-start:user:${user.id}`, PER_RESIDENT_LIMIT, DAY_MS);
    if (limit.unavailable) return NextResponse.json({ error: "Try again shortly." }, { status: 503 });
    if (!limit.ok) return NextResponse.json({ error: "Too many lease starts today. Try again later." }, { status: 429 });

    const scope = await resolveTestWorkspaceRequestScope();
    if (scope.kind === "denied") return NextResponse.json({ error: "Property not found." }, { status: 404 });
    let propertyQuery = db
      .from("manager_property_records")
      .select("id, manager_user_id, status, property_data, test_workspace_id")
      .eq("id", propertyId);
    propertyQuery =
      scope.kind === "active"
        ? propertyQuery.eq("test_workspace_id", scope.workspaceId)
        : propertyQuery.is("test_workspace_id", null);
    const { data: record, error } = await propertyQuery.maybeSingle();
    if (error) return NextResponse.json({ error: "Could not load this home." }, { status: 500 });
    if (!record || record.status !== "live" || !record.manager_user_id) {
      return NextResponse.json({ error: "Property not found." }, { status: 404 });
    }
    const stored = record.property_data as MockProperty | null;
    if (!stored || typeof stored !== "object" || !isPropertyActiveForLeads({ ...stored, adminPublishLive: true })) {
      return NextResponse.json({ error: "Property is not active." }, { status: 404 });
    }

    const managerUserId = String(record.manager_user_id);
    const pipeline = resolveLeasingPipelineForProperty(await loadLeasingPipelineState(db, managerUserId), propertyId);
    if (signingOrderForPipeline(pipeline) !== "lease_first") {
      return NextResponse.json({ error: "This home takes an application first." }, { status: 409 });
    }

    const draft = await createLeaseFirstDraft(db, {
      managerUserId,
      propertyId,
      roomChoice: (body.roomChoice ?? "").trim() || null,
      name: profile?.full_name ?? null,
      email,
    });
    if (!draft.ok) return NextResponse.json({ error: draft.error }, { status: 500 });
    return NextResponse.json({ ok: true, leaseId: draft.leaseId, created: draft.created });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
