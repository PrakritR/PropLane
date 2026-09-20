import { NextResponse } from "next/server";
import type { MockProperty } from "@/data/types";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingServiceOption,
} from "@/lib/manager-listing-submission";
import { pickPrimaryFilingScope } from "@/lib/resident-filing-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  resolveAuthenticatedBusinessAccess,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

function asProperty(value: unknown, id: string): MockProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = value as MockProperty;
  return { ...property, id: property.id?.trim() || id };
}

function applicationBucket(rowData: unknown): string {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return "";
  return String((rowData as { bucket?: string }).bucket ?? "").toLowerCase();
}

function propertyIdFromAppRow(row: {
  property_id?: string | null;
  assigned_property_id?: string | null;
  row_data?: unknown;
}): string {
  const fromCols =
    String(row.assigned_property_id ?? "").trim() || String(row.property_id ?? "").trim();
  if (fromCols) return fromCols;
  const rd =
    row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
      ? (row.row_data as Record<string, unknown>)
      : {};
  return (
    String(rd.assignedPropertyId ?? "").trim() ||
    String(rd.propertyId ?? "").trim() ||
    String((rd.application as { propertyId?: string } | undefined)?.propertyId ?? "").trim()
  );
}

function serviceOffersFromProperty(property: MockProperty): ManagerListingServiceOption[] {
  if (!property.listingSubmission || property.listingSubmission.v !== 1) return [];
  return normalizeManagerListingSubmissionV1(property.listingSubmission).serviceRequestOptions ?? [];
}

/**
 * Resident-scoped property lookup, regardless of publish status — unlike the
 * public catalog/lead routes (live-only), a resident must see their own
 * property's data (e.g. manager-offered service request types) even while it
 * is "review" or "unlisted". Scoped server-side to the resident's own linked
 * application row, never a client-supplied ownership claim.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const businessAccess = await resolveAuthenticatedBusinessAccess(user.id, db);
    if (businessAccess.kind === "denied") {
      return NextResponse.json({ error: "Property access is unavailable for this account." }, { status: 403 });
    }
    const { data: profile } = await db.from("profiles").select("email").eq("id", user.id).maybeSingle();
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "No email on file." }, { status: 400 });

    let applicationsQuery = db
      .from("manager_application_records")
      .select("manager_user_id, property_id, assigned_property_id, row_data, updated_at, test_workspace_id")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false })
      .limit(50);
    applicationsQuery = businessAccess.kind === "test"
      ? applicationsQuery.eq("test_workspace_id", businessAccess.workspaceId)
      : applicationsQuery.is("test_workspace_id", null);
    const { data: appRows, error: appError } = await applicationsQuery;
    if (appError) return NextResponse.json({ error: appError.message }, { status: 500 });

    const rows = appRows ?? [];
    const candidates = rows
      .map((row) => {
        const managerUserId = String(row.manager_user_id ?? "").trim();
        const propertyId = propertyIdFromAppRow(row);
        if (!managerUserId && !propertyId) return null;
        return {
          managerUserId:
            managerUserId ||
            String((row.row_data as { managerUserId?: string } | null)?.managerUserId ?? "").trim(),
          propertyId,
          approved: applicationBucket(row.row_data) === "approved",
          updatedAt: row.updated_at ?? null,
        };
      })
      .filter((c): c is NonNullable<typeof c> => Boolean(c?.managerUserId && c.propertyId));

    const compatibleCandidates = [] as typeof candidates;
    for (const candidate of candidates) {
      const manager = await resolveTestWorkspaceClassification(candidate.managerUserId, db);
      const compatible = businessAccess.kind === "test"
        ? manager.kind === "classified" && manager.workspaceId === businessAccess.workspaceId && manager.state === "active"
        : manager.kind === "normal";
      if (compatible) compatibleCandidates.push(candidate);
    }
    const primary = pickPrimaryFilingScope(compatibleCandidates);
    if (!primary) {
      return NextResponse.json({ error: "No property linked to this resident." }, { status: 404 });
    }
    const propertyId = primary.propertyId;
    const managerUserId = primary.managerUserId;

    let propertyQuery = db
      .from("manager_property_records")
      .select("id, manager_user_id, property_data, status, test_workspace_id")
      .eq("id", propertyId)
      .eq("manager_user_id", managerUserId);
    propertyQuery = businessAccess.kind === "test"
      ? propertyQuery.eq("test_workspace_id", businessAccess.workspaceId)
      : propertyQuery.is("test_workspace_id", null);
    const { data: propRecord, error: propError } = await propertyQuery.maybeSingle();
    if (propError) return NextResponse.json({ error: propError.message }, { status: 500 });

    let property = propRecord ? asProperty(propRecord.property_data, propRecord.id) : null;
    let propertyStatus = String(propRecord?.status ?? "").trim().toLowerCase();

    // Pending/draft listings sometimes live under a different id — soft-match by scanning
    // this manager's properties when the exact id miss fires (id formatting drift).
    if (!property && managerUserId) {
      let managerPropertiesQuery = db
        .from("manager_property_records")
        .select("id, manager_user_id, property_data, status, test_workspace_id")
        .eq("manager_user_id", managerUserId)
        .limit(100);
      managerPropertiesQuery = businessAccess.kind === "test"
        ? managerPropertiesQuery.eq("test_workspace_id", businessAccess.workspaceId)
        : managerPropertiesQuery.is("test_workspace_id", null);
      const { data: managerProps } = await managerPropertiesQuery;
      const token = propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80).toLowerCase();
      const match = (managerProps ?? []).find((row) => {
        const id = String(row.id ?? "").trim();
        if (id === propertyId) return true;
        if (!token) return false;
        return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80).toLowerCase() === token;
      });
      if (match) {
        property = asProperty(match.property_data, match.id);
        propertyStatus = String(match.status ?? "").trim().toLowerCase();
      }
    }

    if (!property) return NextResponse.json({ error: "Property not found." }, { status: 404 });

    const serviceRequestOptions = serviceOffersFromProperty(property);

    // Any-publish-status access is reserved for APPROVED residents. A pending /
    // rejected self-service applicant only ever sees what the public catalog
    // already shows: a live listing, without the manager's listingSubmission
    // internals or draft data.
    if (!primary.approved) {
      if (propertyStatus !== "live" && propertyStatus !== "listed") {
        return NextResponse.json({ error: "No property linked to this resident." }, { status: 404 });
      }
      const { listingSubmission: _internal, ...publicProperty } = property;
      void _internal;
      property = publicProperty as MockProperty;
    }

    return NextResponse.json(
      { property, serviceRequestOptions, managerUserId, propertyId: property.id },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load property." },
      { status: 500 },
    );
  }
}
