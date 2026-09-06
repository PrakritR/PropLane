import { openApplicantRow } from "@/lib/security/applicant-identity";
import { NextResponse } from "next/server";
import { openCosignerIdentity } from "@/lib/security/cosigner-identity";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { applicationPdfFilename, buildApplicationPdf } from "@/lib/manager-application-pdf";
import { loadApplicationGroupMembersForDocument } from "@/lib/application-group-document.server";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

// Application ids are `AXIS-…` / `PROPLANE-…` slugs — never punctuation beyond
// these characters. The check is load-bearing, not cosmetic: the id used to be
// interpolated straight into a PostgREST `.or()` filter on the SERVICE-ROLE
// client, and `normalizeApplicationAxisId` returns its input UNCHANGED for an
// `AXIS-`/`PROPLANE-` prefix, so a comma in the path segment injected extra
// filters over the whole table. The route's 403-vs-404 split then reported
// whether the injected predicate matched, turning it into a blind oracle for
// every manager's applicant SSN, income and date of birth.
//
// Same guard as `resolvePropertyAddressForTour`
// (src/lib/tour-notification-delivery.server.ts). The `.in()` below is
// parameterized and would be safe on its own; this stays as the explicit,
// greppable statement of what an id may contain.
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) =>
    APPLICATION_ID_PATTERN.test(value),
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

    // Authorize against the same scoping the applications list uses.
    const admin = await isAdminUser(user.id);
    let allowed = admin;
    if (!allowed) {
      // The applicant may open their OWN application regardless of primary
      // role — a multi-role account (profiles.role manager/owner who applied
      // as a resident) owns any record carrying its own email, the same
      // email-ownership key the resident applications list and the withdraw
      // guard use.
      const { data: profile } = await db.from("profiles").select("email").eq("id", user.id).maybeSingle();
      const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
      const recordEmail = String(record.resident_email ?? "").trim().toLowerCase();
      allowed = Boolean(email) && recordEmail === email;
      if (!allowed) {
        // Authorize with the SAME owned-property predicate the applications list
        // uses, so a manager can open a row the list shows them — including an
        // "Incomplete" draft with a stale `manager_user_id` on a property they
        // own. The old check only accepted the frozen stamp + co-manager links,
        // never DIRECT ownership, so the owner got a 403 (rendered as raw JSON
        // in the preview frame) for their own applicant.
        allowed = await managerCanAccessApplicationRecord(db, user.id, record);
      }
    }
    if (!allowed) return NextResponse.json({ error: "Not authorized for this application." }, { status: 403 });

    const row = openApplicantRow(record.row_data, record.id);
    const url = new URL(req.url);
    const roomLabel = url.searchParams.get("roomLabel")?.trim() || undefined;
    // Inline disposition lets the manager UI embed the PDF in a preview frame instead of downloading it.
    const inline = url.searchParams.get("disposition") === "inline";

    const signerIds = [...new Set([...ids, ...ids.map((v) => v.toUpperCase())])];
    const { data: cosignerRows } = await db
      .from("cosigner_submission_records")
      .select("id, row_data, created_at")
      .in("signer_app_id", signerIds)
      .order("created_at", { ascending: true });
    const cosignerSubmissions = (cosignerRows ?? [])
      .map((r) => r.row_data ? openCosignerIdentity(r.row_data, String(r.id)) : null)
      .filter(Boolean) as CosignerSubmission[];

    const groupMembers = await loadApplicationGroupMembersForDocument(db, row, {
      managerUserId: record.manager_user_id ?? null,
    });

    const pdf = await buildApplicationPdf(row, { roomLabel, cosignerSubmissions, groupMembers });
    const filename = applicationPdfFilename(row);

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build application PDF.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
