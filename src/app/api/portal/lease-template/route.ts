import { NextResponse } from "next/server";
import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import {
  collectSubmissionLeaseTemplatePaths,
  isLeaseTemplatePath,
  LEASE_TEMPLATE_BUCKET,
  LEASE_TEMPLATE_MAX_BYTES,
  leaseTemplateUrlForPath,
} from "@/lib/lease-template-storage";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { residentHasApprovedResidency, resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Denials are 404, never 403, so the route never confirms that a path exists. */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

function submissionOf(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object" || Array.isArray(propertyData)) return null;
  const sub = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
  return sub as ManagerListingSubmissionV1;
}

type PropertyRow = { id?: string; manager_user_id?: string | null; property_data?: unknown };
const PROPERTY_COLUMNS = "id, manager_user_id, property_data";

/**
 * Rows that reference this exact object path AND that the object's FOLDER OWNER
 * could legitimately have attached it to — their own listing, or one they
 * co-manage.
 *
 * Both halves are load-bearing. "A property I can see references this path" is
 * not sufficient on its own, because the submission is a manager-editable blob:
 * a manager can write any string into `leaseTemplateDocUrl` on their OWN listing
 * (the wizard mirrors `property_data` verbatim), so without the folder-owner
 * half they could paste another manager's path onto their own property and read
 * the document back. The folder id is not even secret — `managerUserId` ships in
 * the public listing payload — so the path is a weak secret and never the gate.
 */
function rowsLegitimatelyReference(
  rows: PropertyRow[] | null | undefined,
  path: string,
  folderOwner: string,
  folderOwnerCoManages: Set<string>,
): boolean {
  return (rows ?? []).some((row) => {
    const attachable =
      row.manager_user_id === folderOwner || (row.id ? folderOwnerCoManages.has(row.id) : false);
    return attachable && collectSubmissionLeaseTemplatePaths(submissionOf(row.property_data)).has(path);
  });
}

/**
 * Does a property this caller may see still reference this exact object path?
 *
 * Ownership is re-derived from `manager_user_id` and NOT from the object's
 * folder, because the two genuinely differ: a co-manager's upload lands in the
 * co-manager's folder while the URL is stored on the owner's listing, and a
 * transferred property changes hands without moving any object.
 */
async function accessiblePropertyReferencesTemplate(
  db: ServiceClient,
  userId: string,
  email: string,
  path: string,
): Promise<boolean> {
  const folderOwner = path.split("/")[0] ?? "";
  const folderOwnerCoManages = await linkedPropertyIdsForModule(db, folderOwner, "properties");
  const references = (rows: PropertyRow[] | null | undefined) =>
    rowsLegitimatelyReference(rows, path, folderOwner, folderOwnerCoManages);

  const { data: owned } = await db
    .from("manager_property_records")
    .select(PROPERTY_COLUMNS)
    .eq("manager_user_id", userId);
  if (references(owned)) return true;

  const linked = await linkedPropertyIdsForModule(db, userId, "properties");
  if (linked.size > 0) {
    const { data } = await db.from("manager_property_records").select(PROPERTY_COLUMNS).in("id", [...linked]);
    if (references(data)) return true;
  }

  if (!email) return false;
  const scope = await resolveResidentFilingScope(db, { residentEmail: email });
  if (!scope?.propertyId) return false;
  // A pending applicant is NOT a resident. `/api/portal/resident-property`
  // draws the same line — it strips `listingSubmission` for an unapproved
  // applicant so a prospect only ever sees what the public catalog shows — and
  // the two routes must not disagree about the same trust boundary.
  if (!(await residentHasApprovedResidency(db, { residentEmail: email, managerUserId: scope.managerUserId }))) {
    return false;
  }
  const { data } = await db.from("manager_property_records").select(PROPERTY_COLUMNS).in("id", [scope.propertyId]);
  return references(data);
}

/**
 * Is this path embedded in a lease document the caller is a party to?
 *
 * Required because the generated lease HTML bakes the template URL in
 * permanently (`generated-lease.ts`) and is never rewritten. When a manager
 * replaces a property's template, the listing stops referencing the old object
 * but every already-signed lease still points at it — without this branch the
 * resident who signed that document would get a 404 on their own lease, which
 * the public URL never did.
 */
async function leaseDocumentEmbedsTemplate(
  db: ServiceClient,
  userId: string,
  email: string,
  path: string,
): Promise<boolean> {
  const url = leaseTemplateUrlForPath(path);
  const folderOwner = path.split("/")[0] ?? "";
  const folderOwnerCoManages = await linkedPropertyIdsForModule(db, folderOwner, "properties");
  // Same two halves as the property check: a lease row is manager-editable and
  // mirrored to the server, so "a lease of mine embeds this URL" alone would let
  // a manager mint a row quoting someone else's path. The lease must belong to
  // the folder owner's own book of business.
  const embedded = (
    rows: { manager_user_id?: string | null; property_id?: string | null; row_data?: unknown }[] | null | undefined,
  ) =>
    (rows ?? []).some((row) => {
      const attachable =
        row.manager_user_id === folderOwner || (row.property_id ? folderOwnerCoManages.has(row.property_id) : false);
      if (!attachable) return false;
      const html = (row.row_data as { generatedHtml?: unknown } | null)?.generatedHtml;
      return typeof html === "string" && html.includes(url);
    });

  const columns = "manager_user_id, property_id, row_data";
  const { data: asManager } = await db
    .from("portal_lease_pipeline_records")
    .select(columns)
    .eq("manager_user_id", userId);
  if (embedded(asManager)) return true;

  if (!email) return false;
  // `.eq` on the already-lowercased email, never `.ilike` — an address may
  // legally contain `_`, which ilike would treat as a wildcard and widen the
  // match to other people's leases.
  const { data: asResident } = await db
    .from("portal_lease_pipeline_records")
    .select(columns)
    .eq("resident_email", email);
  return embedded(asResident);
}

/**
 * May this signed-in user read this template? Checked by RELATIONSHIP, not by
 * portal role, so a multi-role account (a manager who also rents somewhere) is
 * judged on each relationship it actually holds:
 *   - the manager who uploaded it, by the object's own folder
 *   - the owning manager or an assigned co-manager of a property referencing it
 *   - the approved resident of such a property
 *   - either party to a lease document that already embeds it
 */
async function canReadLeaseTemplate(
  db: ServiceClient,
  userId: string,
  email: string,
  path: string,
): Promise<boolean> {
  if (path.split("/")[0] === userId) return true;
  if (await accessiblePropertyReferencesTemplate(db, userId, email, path)) return true;
  return leaseDocumentEmbedsTemplate(db, userId, email, path);
}

// ---------------------------------------------------------------------------
// GET ?path=<uid>/<file>.pdf — stream the template's bytes.
//
// Streamed rather than redirected to a signed storage URL: the value stored on
// the submission is baked into the persisted generated-lease HTML as an
// `<object data=…>`, which outlives any signed-URL TTL, and the documents module
// already learned that a 302 to storage opens a new tab in the Capacitor WebView
// instead of rendering. The privacy guarantee is identical — the bucket is
// private and every request is re-authorized here.
// ---------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const path = new URL(req.url).searchParams.get("path")?.trim() ?? "";
    if (!isLeaseTemplatePath(path)) return notFound();

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return notFound();

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email").eq("id", user.id).maybeSingle();
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    if (!(await canReadLeaseTemplate(db, user.id, email, path))) return notFound();

    const { data, error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).download(path);
    if (error || !data) return notFound();
    return new NextResponse(Buffer.from(await data.arrayBuffer()), {
      headers: {
        "Content-Type": "application/pdf",
        // Constant, never the stored filename — nothing manager-supplied builds
        // this header. `nosniff` because these bytes are uploaded by one account
        // and rendered inline in another's browser (a resident opening their
        // lease), so a mislabelled upload must not be sniffed into markup.
        "Content-Disposition": 'inline; filename="lease-template.pdf"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return notFound();
  }
}

// ---------------------------------------------------------------------------
// POST (multipart `file`) — upload a template into the caller's own folder.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }
    // Uploaded objects carry no property association, so nothing else bounds how
    // many a manager can push into a bucket on a free-plan storage budget.
    if (!(await rateLimit(`lease-template-upload:${auth.userId}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many uploads. Try again in a minute." }, { status: 429 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file." }, { status: 400 });
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      return NextResponse.json({ error: "Upload the lease template as a PDF." }, { status: 400 });
    }
    if (file.size === 0 || file.size > LEASE_TEMPLATE_MAX_BYTES) {
      return NextResponse.json({ error: "Lease template is too large. Keep it under 8 MB." }, { status: 400 });
    }

    // The folder is the AUTHENTICATED user's id, never a name from the request —
    // it is what the read path treats as ownership.
    const path = `${auth.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
    const { error } = await auth.db.storage.from(LEASE_TEMPLATE_BUCKET).upload(path, file, {
      contentType: "application/pdf",
      cacheControl: "0",
      upsert: false,
    });
    if (error) return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 502 });
    return NextResponse.json({ path });
  } catch {
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE { paths: string[] } — reclaim objects a discarded submission owned.
// Only the folder owner may remove, so one manager can never strip another's.
// ---------------------------------------------------------------------------
export async function DELETE(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { paths?: unknown };
    const paths = (Array.isArray(body.paths) ? body.paths : [])
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => isLeaseTemplatePath(p) && p.split("/")[0] === user.id);
    if (paths.length === 0) return NextResponse.json({ ok: true, removed: 0 });

    const db = createSupabaseServiceRoleClient();
    const { error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).remove(paths);
    if (error) return NextResponse.json({ error: "Could not remove the file." }, { status: 502 });
    return NextResponse.json({ ok: true, removed: paths.length });
  } catch {
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }
}
