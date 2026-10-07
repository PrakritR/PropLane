import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import {
  DOCUMENT_SELECT_COLUMNS,
  loadSharedWithOwnersIds,
  isDocumentCategory,
  isDocumentVisibility,
  mapDocumentRow,
  sanitizeDisplayName,
  UUID_PATTERN,
  validateDocumentVisibilityScope,
  type ManagerDocumentRow,
  type ManagerDocumentVisibility,
} from "@/lib/documents/manager-documents";
import { assertManagerDocumentsCoManagerAccess } from "@/lib/auth/co-manager-access";
import { managerOwnsVendorDirectoryRow, resolveResidentUserIdByEmail } from "@/lib/documents/document-scope.server";
import { notifyDocumentShared } from "@/lib/documents/document-share-notify.server";
import { parseExpiresAtInput } from "@/lib/documents/document-expiration";

export const runtime = "nodejs";

function strField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// PATCH /api/manager-documents/[id] — rename, recategorize, or update sharing.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { data: existing, error: readError } = await auth.db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  // Owner OR a co-manager with the documents EDIT grant on the doc's property.
  // (assertCoManagerModuleAccess short-circuits true when owner === caller.)
  const existingOwnerId = String((existing as ManagerDocumentRow).manager_user_id ?? "");
  const existingPropertyId = (existing as ManagerDocumentRow).property_id ?? null;
  const editGate = await assertManagerDocumentsCoManagerAccess(
    auth.db,
    auth.userId,
    existingPropertyId,
    existingOwnerId,
    "edit",
  );
  if (!editGate.ok) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // A co-manager (non-owner) may rename/recategorize/re-date a linked document,
  // but must NOT change its sharing scope — otherwise they could flip an owner's
  // private doc to vendor/resident visibility and point it at their OWN vendor
  // (validated against the caller, not the owner), exfiltrating it out of the
  // owner's trust boundary. Sharing changes stay owner-only.
  const isOwner = existingOwnerId === auth.userId;
  if (
    !isOwner &&
    (body.visibility !== undefined ||
      body.residentUserId !== undefined ||
      body.residentEmail !== undefined ||
      body.vendorId !== undefined ||
      body.sharedWithOwners !== undefined)
  ) {
    return NextResponse.json(
      { error: "Only the document owner can change sharing." },
      { status: 403 },
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // A blank/whitespace rename is rejected rather than silently renamed to the
  // "Untitled document" fallback, which would look like data loss to the manager.
  if (typeof body.displayName === "string") {
    const cleaned = sanitizeDisplayName(body.displayName, "");
    if (!cleaned) return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    update.display_name = cleaned;
  }
  if (typeof body.category === "string" && isDocumentCategory(body.category)) update.category = body.category;

  const prevRow = existing as ManagerDocumentRow;
  const prevVisibility = isDocumentVisibility(prevRow.visibility) ? prevRow.visibility : "manager";

  let nextVisibility: ManagerDocumentVisibility = prevVisibility;
  if (typeof body.visibility === "string" && isDocumentVisibility(body.visibility)) {
    nextVisibility = body.visibility;
    update.visibility = nextVisibility;
  }

  const residentUserId = strField(body.residentUserId);
  const residentEmailRaw = strField(body.residentEmail);
  const residentEmail =
    residentEmailRaw === undefined ? undefined : residentEmailRaw ? residentEmailRaw.toLowerCase() : null;
  const vendorId = strField(body.vendorId);

  if (residentUserId !== undefined) update.resident_user_id = residentUserId;
  if (residentEmail !== undefined) update.resident_email = residentEmail;
  if (vendorId !== undefined) update.vendor_id = vendorId;

  if (body.expiresAt === null || body.expiresAt === "") {
    update.expires_at = null;
  } else if (typeof body.expiresAt === "string") {
    const parsed = parseExpiresAtInput(body.expiresAt);
    if (!parsed) return NextResponse.json({ error: "expiresAt must be YYYY-MM-DD." }, { status: 400 });
    update.expires_at = parsed;
  }

  // Share with Property owners. Owner-only (guarded above) and house-scoped: an
  // owner reads a document through a granted HOUSE, so a document with no
  // property has nobody to share it with.
  if (body.sharedWithOwners !== undefined) {
    if (typeof body.sharedWithOwners !== "boolean") {
      return NextResponse.json({ error: "sharedWithOwners must be true or false." }, { status: 400 });
    }
    if (body.sharedWithOwners && !existingPropertyId) {
      return NextResponse.json({ error: "Choose a house for this document before sharing it with owners." }, { status: 400 });
    }
    update.shared_with_owners = body.sharedWithOwners;
  }

  if (nextVisibility === "manager") {
    update.resident_user_id = null;
    update.resident_email = null;
    update.vendor_id = null;
  }

  const scopeError = validateDocumentVisibilityScope({
    visibility: nextVisibility,
    residentUserId: (update.resident_user_id as string | null | undefined) ?? prevRow.resident_user_id,
    residentEmail: (update.resident_email as string | null | undefined) ?? prevRow.resident_email,
    vendorId: (update.vendor_id as string | null | undefined) ?? prevRow.vendor_id,
  });
  if (scopeError) return NextResponse.json({ error: scopeError }, { status: 400 });

  const effectiveVendorId = (update.vendor_id as string | null | undefined) ?? prevRow.vendor_id;
  if (nextVisibility === "vendor" && effectiveVendorId) {
    const owns = await managerOwnsVendorDirectoryRow(auth.db, auth.userId, effectiveVendorId);
    if (!owns) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  }

  let effectiveResidentUserId =
    (update.resident_user_id as string | null | undefined) ?? prevRow.resident_user_id;
  const effectiveResidentEmail =
    (update.resident_email as string | null | undefined) ?? prevRow.resident_email;
  if (nextVisibility === "resident" && !effectiveResidentUserId && effectiveResidentEmail) {
    effectiveResidentUserId = await resolveResidentUserIdByEmail(auth.db, effectiveResidentEmail);
    if (effectiveResidentUserId) update.resident_user_id = effectiveResidentUserId;
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const { data, error } = await auth.db
    .from("manager_documents")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select(DOCUMENT_SELECT_COLUMNS)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const notify =
    body.notifyOnShare !== false &&
    prevVisibility === "manager" &&
    (nextVisibility === "resident" || nextVisibility === "vendor");

  if (notify && (nextVisibility === "resident" || nextVisibility === "vendor")) {
    const mapped = mapDocumentRow(data as ManagerDocumentRow);
    const { data: profile } = await auth.db.from("profiles").select("full_name, email").eq("id", auth.userId).maybeSingle();
    await notifyDocumentShared(auth.db, {
      managerUserId: auth.userId,
      managerEmail: auth.email,
      managerName: String(profile?.full_name ?? "Your property manager"),
      documentId: mapped.id,
      documentName: mapped.displayName,
      visibility: nextVisibility,
      residentUserId: mapped.scope.residentUserId,
      residentEmail: mapped.scope.residentEmail,
      vendorId: mapped.scope.vendorId,
    });
  }

  const sharedIds = await loadSharedWithOwnersIds(auth.db, [id]);
  return NextResponse.json({
    document: { ...mapDocumentRow(data as ManagerDocumentRow), sharedWithOwners: sharedIds.has(id) },
  });
}

// DELETE /api/manager-documents/[id] — soft-delete (sets deleted_at). The
// storage object is intentionally kept so a future "restore"/versioning flow
// can recover it; hard purge is out of scope this phase.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  // Owner OR a co-manager with the documents DELETE grant on the doc's property.
  const { data: existing, error: readError } = await auth.db
    .from("manager_documents")
    .select("id, manager_user_id, property_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const delGate = await assertManagerDocumentsCoManagerAccess(
    auth.db,
    auth.userId,
    (existing as { property_id: string | null }).property_id,
    String((existing as { manager_user_id: string | null }).manager_user_id ?? ""),
    "delete",
  );
  if (!delGate.ok) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { data, error } = await auth.db
    .from("manager_documents")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
