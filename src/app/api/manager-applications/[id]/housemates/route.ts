import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { loadHousematesForApplicationRow, propertyIdFromAppRow } from "@/lib/resident-move-in-info";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

// Same id guard as the application PDF route: an id is an `AXIS-…` / `PROPLANE-…`
// slug and nothing else, so it can never widen a filter on the service-role client.
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) =>
    APPLICATION_ID_PATTERN.test(value),
  );
}

/**
 * The household peers of one application record, for the manager resident record's
 * Move in › Roommates sub-tab.
 *
 * TWO authorizations, because the answer is about a different object than the key:
 *
 *  1. the application record, with the same predicate the Applications list uses, and
 *  2. the PROPERTY the household lives at, re-derived from the stored row.
 *
 * The second is not redundant. `managerCanAccessApplicationRecord` passes on the
 * record's frozen `manager_user_id` alone, and the property id inside `row_data` is
 * writable by the manager who owns that record — so without (2) a manager could point
 * their own application row at someone else's property and read that household. The
 * property check deliberately omits `manager_user_id` so the record's stamp cannot
 * stand in for owning (or co-managing) the property.
 *
 * The peers come back through the resident's own loader, so each one is redacted by its
 * own sharing preferences — the manager sees what the resident sees, nothing wider.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await ctx.params;
    const id = (rawId ?? "").trim();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const ids = idVariants(id);
    if (ids.length === 0) return NextResponse.json({ error: "Application not found." }, { status: 404 });
    const { data: records, error } = await db
      .from("manager_application_records")
      .select("id, row_data, manager_user_id, resident_email, property_id, assigned_property_id")
      .in("id", ids)
      .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const record = records?.[0];
    if (!record?.row_data) return NextResponse.json({ error: "Application not found." }, { status: 404 });

    const admin = await isAdminUser(user.id);
    const allowed = admin || (await managerCanAccessApplicationRecord(db, user.id, record));
    if (!allowed) return NextResponse.json({ error: "Not authorized for this application." }, { status: 403 });

    const row = openApplicantRow(record.row_data, record.id);
    const propertyId = propertyIdFromAppRow(row);
    if (!propertyId) {
      return NextResponse.json({ housemates: [] }, { headers: privateHeaders });
    }
    const propertyAllowed =
      admin || (await managerCanAccessApplicationRecord(db, user.id, { property_id: propertyId }));
    if (!propertyAllowed) {
      return NextResponse.json({ error: "Not authorized for this property." }, { status: 403 });
    }

    const selfEmail = String(record.resident_email ?? row.email ?? "").trim().toLowerCase();
    const housemates = await loadHousematesForApplicationRow(db, row, {
      selfEmail,
      propertyId,
      managerUserId: record.manager_user_id ?? null,
    });

    return NextResponse.json({ housemates }, { headers: privateHeaders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load housemates.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
