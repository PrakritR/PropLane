import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import {
  MANAGER_DOCUMENTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  DOCUMENT_SELECT_COLUMNS,
  buildDocumentStoragePath,
  extensionForMime,
  isAllowedDocumentMime,
  isDocumentCategory,
  isDocumentVisibility,
  mapDocumentRow,
  sanitizeDisplayName,
  UUID_PATTERN,
  validateDocumentVisibilityScope,
  validateDocumentVersionUpload,
  type ManagerDocumentRow,
  type ManagerDocumentVisibility,
} from "@/lib/documents/manager-documents";
import { managerOwnsVendorDirectoryRow, resolveResidentUserIdByEmail } from "@/lib/documents/document-scope.server";
import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { notifyDocumentShared } from "@/lib/documents/document-share-notify.server";
import { defaultExpiryIsoForCategory, parseExpiresAtInput } from "@/lib/documents/document-expiration";
import {
  applyWorkspaceRowScope,
  resolveActiveWorkspaceRowScope,
  rowAllowedInWorkspaceScope,
} from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

// GET /api/manager-documents — list the signed-in manager's live documents,
// with optional filters. Soft-deleted rows are always excluded.
export async function GET(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const url = new URL(req.url);
  const category = url.searchParams.get("category");
  const propertyId = url.searchParams.get("propertyId");
  const scope = url.searchParams.get("scope"); // scope-kind filter
  const search = (url.searchParams.get("q") ?? "").trim();

  // Shared filter set, applied identically to the owned and linked-property queries.
  const buildQuery = () => {
    let query = auth.db
      .from("manager_documents")
      .select(DOCUMENT_SELECT_COLUMNS)
      .is("deleted_at", null)
      .is("superseded_by_document_id", null)
      .order("created_at", { ascending: false })
      .limit(500);

    if (category && isDocumentCategory(category)) query = query.eq("category", category);
    if (propertyId) query = query.eq("property_id", propertyId);
    if (search) query = query.ilike("display_name", `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);

    // Scope-kind filters map to "which polymorphic column is set".
    if (scope === "manager") {
      query = query
        .is("property_id", null)
        .is("unit_label", null)
        .is("lease_id", null)
        .is("resident_user_id", null)
        .is("vendor_id", null)
        .is("work_order_id", null);
    } else if (scope === "property") {
      query = query.not("property_id", "is", null);
    } else if (scope === "resident") {
      query = query.not("resident_user_id", "is", null);
    } else if (scope === "vendor") {
      query = query.not("vendor_id", "is", null);
    } else if (scope === "work_order") {
      query = query.not("work_order_id", "is", null);
    } else if (scope === "lease") {
      query = query.not("lease_id", "is", null);
    }

    return query;
  };

  // The active workspace's houses, plus whether it is the viewer's own
  // default — an account-level document (no property at all, `scope=manager`)
  // only shows there, matching the rule Communication already follows.
  const wsScope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);

  const { data, error } = await applyWorkspaceRowScope(
    buildQuery().eq("manager_user_id", auth.userId),
    wsScope,
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rowsById = new Map<string, ManagerDocumentRow>();
  for (const row of (data as ManagerDocumentRow[] | null) ?? []) rowsById.set(row.id, row);

  // Co-manager visibility: also list property-scoped documents on properties
  // this user is linked to for the documents module. The `.in("property_id", …)`
  // predicate only matches rows with a property set, so other owners'
  // manager-level documents (property_id null) can never leak. Skipped for the
  // manager scope filter, which by definition matches only property-less rows.
  // These rows are never account-level (always `.in("property_id", …)`), so
  // the workspace scope narrows them by property membership only — never the
  // untagged/default-workspace branch, which applies only to the viewer's own
  // rows above.
  const linkedPropertyIds = await linkedPropertyIdsForModule(auth.db, auth.userId, "documents");
  if (linkedPropertyIds.size > 0 && scope !== "manager") {
    const { data: linkedData, error: linkedError } = await applyWorkspaceRowScope(
      buildQuery().in("property_id", [...linkedPropertyIds]).neq("manager_user_id", auth.userId),
      { propertyIds: wsScope.propertyIds, includeUntagged: false },
    );
    if (linkedError) return NextResponse.json({ error: linkedError.message }, { status: 500 });
    for (const row of (linkedData as ManagerDocumentRow[] | null) ?? []) {
      if (!rowsById.has(row.id)) rowsById.set(row.id, row);
    }
  }

  const documents = [...rowsById.values()]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(mapDocumentRow);
  return NextResponse.json({ documents });
}

// POST /api/manager-documents — multipart upload of a new document.
export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const gate = await assertManagerFinancialsAccess(auth);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required." }, { status: 400 });

  const mime = file.type || "application/octet-stream";
  if (!isAllowedDocumentMime(mime)) {
    return NextResponse.json({ error: `Unsupported file type: ${mime}.` }, { status: 415 });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json({ error: "File exceeds the 25 MB limit." }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) return NextResponse.json({ error: "Empty file." }, { status: 400 });
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return NextResponse.json({ error: "File exceeds the 25 MB limit." }, { status: 413 });
  }

  const checksum = createHash("sha256").update(bytes).digest("hex");
  const ext = extensionForMime(mime, file.name);
  const storagePath = buildDocumentStoragePath(auth.userId, ext, `${Date.now()}-${randomUUID()}`);

  const str = (key: string): string | null => {
    const v = form.get(key);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const rawCategory = str("category");
  const category = rawCategory && isDocumentCategory(rawCategory) ? rawCategory : "other";
  const supersedeDocumentId = str("supersedeDocumentId");
  let priorRow: ManagerDocumentRow | null = null;

  if (supersedeDocumentId) {
    if (!UUID_PATTERN.test(supersedeDocumentId)) {
      return NextResponse.json({ error: "supersedeDocumentId must be a UUID." }, { status: 400 });
    }
    const { data: prior, error: priorError } = await auth.db
      .from("manager_documents")
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq("id", supersedeDocumentId)
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (priorError) return NextResponse.json({ error: priorError.message }, { status: 500 });
    if (!prior) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    priorRow = prior as ManagerDocumentRow;
    // Uploading a new version acts on the prior row (links it via
    // `superseded_by_document_id`) — refuse it exactly like a missing
    // document when it sits outside the manager's active workspace.
    const priorScope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    if (!rowAllowedInWorkspaceScope(priorScope, priorRow.property_id)) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    const versionError = validateDocumentVersionUpload({
      priorManagerUserId: priorRow.manager_user_id,
      managerUserId: auth.userId,
      priorSupersededByDocumentId: priorRow.superseded_by_document_id,
    });
    if (versionError) return NextResponse.json({ error: versionError }, { status: 409 });
  }

  const displayName = sanitizeDisplayName(str("displayName") ?? file.name, file.name || "Untitled document");

  const residentUserId = str("residentUserId");
  if (residentUserId && !UUID_PATTERN.test(residentUserId)) {
    return NextResponse.json({ error: "residentUserId must be a UUID." }, { status: 400 });
  }
  const residentEmail = str("residentEmail")?.toLowerCase() ?? null;
  const vendorId = str("vendorId");
  const rawVisibility = str("visibility");
  const visibility: ManagerDocumentVisibility =
    rawVisibility && isDocumentVisibility(rawVisibility) ? rawVisibility : "manager";

  const scopeError = validateDocumentVisibilityScope({
    visibility,
    residentUserId,
    residentEmail,
    vendorId,
  });
  if (scopeError) return NextResponse.json({ error: scopeError }, { status: 400 });

  if (visibility === "vendor" && vendorId) {
    const owns = await managerOwnsVendorDirectoryRow(auth.db, auth.userId, vendorId);
    if (!owns) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  }

  let resolvedResidentUserId = residentUserId;
  if (visibility === "resident" && !resolvedResidentUserId && residentEmail) {
    resolvedResidentUserId = await resolveResidentUserIdByEmail(auth.db, residentEmail);
  }

  const rawExpiresAt = str("expiresAt");
  let expiresAt: string | null = null;
  if (rawExpiresAt) {
    expiresAt = parseExpiresAtInput(rawExpiresAt);
    if (!expiresAt) return NextResponse.json({ error: "expiresAt must be YYYY-MM-DD." }, { status: 400 });
  } else {
    expiresAt = defaultExpiryIsoForCategory(category);
  }

  // A document tied to a house must land in the manager's active workspace.
  // An account-level document (no house — a lease template, a portfolio
  // policy) has no workspace to land in and is scoped on read by the
  // default-workspace rule instead.
  const resolvedPropertyId = str("propertyId") ?? priorRow?.property_id ?? null;
  if (resolvedPropertyId) {
    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    if (scope.propertyIds !== null && !scope.propertyIds.includes(resolvedPropertyId)) {
      return NextResponse.json({ error: "This property is outside your active workspace." }, { status: 400 });
    }
  }

  const { error: uploadError } = await auth.db.storage
    .from(MANAGER_DOCUMENTS_BUCKET)
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const insertRow = {
    manager_user_id: auth.userId,
    display_name: displayName,
    original_filename: file.name || null,
    mime_type: mime,
    size_bytes: bytes.byteLength,
    checksum,
    storage_path: storagePath,
    category: priorRow && isDocumentCategory(priorRow.category) ? priorRow.category : category,
    property_id: resolvedPropertyId,
    unit_label: str("unitLabel") ?? priorRow?.unit_label ?? null,
    lease_id: str("leaseId") ?? priorRow?.lease_id ?? null,
    resident_user_id: resolvedResidentUserId ?? priorRow?.resident_user_id ?? null,
    resident_email: residentEmail ?? priorRow?.resident_email ?? null,
    vendor_id: (visibility === "vendor" ? vendorId : null) ?? priorRow?.vendor_id ?? null,
    work_order_id: str("workOrderId") ?? priorRow?.work_order_id ?? null,
    visibility: priorRow && isDocumentVisibility(priorRow.visibility) ? priorRow.visibility : visibility,
    expires_at: expiresAt ?? priorRow?.expires_at ?? null,
    uploaded_by: auth.userId,
  };

  const { data, error } = await auth.db
    .from("manager_documents")
    .insert(insertRow)
    .select(DOCUMENT_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    // Roll back the orphaned storage object so we never leak untracked bytes.
    await auth.db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove([storagePath]);
    return NextResponse.json({ error: error?.message ?? "Failed to save document." }, { status: 500 });
  }

  const document = mapDocumentRow(data as ManagerDocumentRow);

  if (priorRow) {
    const { error: linkError } = await auth.db
      .from("manager_documents")
      .update({
        superseded_by_document_id: document.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", priorRow.id)
      .eq("manager_user_id", auth.userId)
      .is("deleted_at", null)
      .is("superseded_by_document_id", null);
    if (linkError) {
      await auth.db.from("manager_documents").delete().eq("id", document.id);
      await auth.db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove([storagePath]);
      return NextResponse.json({ error: linkError.message }, { status: 500 });
    }
  }

  track("document_uploaded", auth.userId, {
    category: document.category,
    scope_kind: document.scopeKind,
    visibility: document.visibility,
    version_upload: Boolean(priorRow),
  });

  if (visibility === "resident" || visibility === "vendor") {
    const { data: profile } = await auth.db.from("profiles").select("full_name, email").eq("id", auth.userId).maybeSingle();
    await notifyDocumentShared(auth.db, {
      managerUserId: auth.userId,
      managerEmail: auth.email,
      managerName: String(profile?.full_name ?? "Your property manager"),
      documentId: document.id,
      documentName: document.displayName,
      visibility,
      residentUserId: resolvedResidentUserId,
      residentEmail,
      vendorId,
    });
  }

  return NextResponse.json({ document }, { status: 201 });
}
