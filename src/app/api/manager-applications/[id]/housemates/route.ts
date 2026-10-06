import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { loadHousematesForApplicationRow } from "@/lib/resident-move-in-info";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

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
 * The id in the path is a lookup key, never authorization: the record is loaded and
 * then authorized with the same predicate the Applications list uses, and every id
 * the answer is built from (property, room, email) is read from the stored row. The
 * peers come back through the resident's own loader, so each one is redacted by its
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

    const allowed =
      (await isAdminUser(user.id)) || (await managerCanAccessApplicationRecord(db, user.id, record));
    if (!allowed) return NextResponse.json({ error: "Not authorized for this application." }, { status: 403 });

    const row = openApplicantRow(record.row_data, record.id);
    const selfEmail = String(record.resident_email ?? row.email ?? "").trim().toLowerCase();
    const housemates = await loadHousematesForApplicationRow(db, row, {
      selfEmail,
      managerUserId: record.manager_user_id ?? null,
    });

    return NextResponse.json({ housemates }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load housemates.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
