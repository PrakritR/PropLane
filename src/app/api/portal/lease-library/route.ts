import { NextResponse } from "next/server";
import { assertSettingsScopeOwned, resolveSettingsScopeParams } from "@/lib/scope/settings-scope";
import { isLeaseTemplatePath, LEASE_TEMPLATE_BUCKET, leaseTemplateUrlForPath } from "@/lib/lease-template-storage";
import { normalizeLeaseDocumentFields } from "@/lib/lease-document-library";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export const runtime = "nodejs";

/**
 * Row-level metadata API for the workspace lease document library
 * (`lease_document_library`). Bytes stay in the existing private
 * `lease-templates` bucket and are uploaded/streamed through the existing
 * `/api/portal/lease-template` route; this route only ever reads/writes the
 * small metadata row (name, path, default flag, field placements) and, on
 * delete, reclaims the underlying object once no property or lease still
 * references it.
 *
 * Authorization is workspace access, resolved the same way every other
 * per-workspace settings route resolves it (`assertSettingsScopeOwned` with
 * the "leases" co-manager module) — never trusted from the client beyond
 * which workspace/property it is asking about.
 */

type LibraryRow = {
  id: string;
  workspace_id: string;
  manager_user_id: string;
  name: string;
  storage_path: string;
  file_name: string;
  is_default: boolean;
  fields: unknown;
  created_at: string;
  updated_at: string;
};

function toApiEntry(row: LibraryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    managerUserId: row.manager_user_id,
    name: row.name,
    storagePath: row.storage_path,
    fileName: row.file_name,
    isDefault: row.is_default,
    fields: normalizeLeaseDocumentFields(row.fields),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: leaseTemplateUrlForPath(row.storage_path),
  };
}

async function resolveWorkspaceId(
  db: ServiceClient,
  callerUserId: string,
  requested: string | undefined,
): Promise<string | null> {
  if (requested) return requested;
  const { data } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", callerUserId)
    .eq("is_default", true)
    .maybeSingle();
  return data?.id ? String(data.id) : null;
}

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }
    const scope = resolveSettingsScopeParams(req.url);
    const workspaceId = await resolveWorkspaceId(auth.db, auth.userId, scope.workspaceId);
    if (!workspaceId) return NextResponse.json({ entries: [] });
    const access = await assertSettingsScopeOwned(auth.db, auth.userId, { workspaceId }, { module: "leases", level: "read" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const { data, error } = await auth.db
      .from("lease_document_library")
      .select("id, workspace_id, manager_user_id, name, storage_path, file_name, is_default, fields, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: "Could not load the lease document library." }, { status: 500 });
    return NextResponse.json({ entries: ((data ?? []) as LibraryRow[]).map(toApiEntry) });
  } catch {
    return NextResponse.json({ error: "Could not load the lease document library." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }
    if (!(await rateLimit(`lease-library-create:${auth.userId}`, 30, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      storagePath?: string;
      name?: string;
      fileName?: string;
      workspaceId?: string;
    };
    const storagePath = body.storagePath?.trim() ?? "";
    const name = body.name?.trim().slice(0, 120) ?? "";
    const fileName = body.fileName?.trim().slice(0, 200) || "Lease document.pdf";
    if (!isLeaseTemplatePath(storagePath)) {
      return NextResponse.json({ error: "Invalid document." }, { status: 400 });
    }
    // The uploader owns the object's folder (`lease-template-storage.ts`'s
    // `<manager user id>/<unique>.pdf` convention) — a manager can only
    // register an object they themselves just uploaded, never someone else's
    // path, closing the same "planted path" hole `/api/portal/lease-template`
    // already guards against.
    if (storagePath.split("/")[0] !== auth.userId) {
      return NextResponse.json({ error: "That document was not uploaded by you." }, { status: 403 });
    }
    if (!name) return NextResponse.json({ error: "Name the lease document." }, { status: 400 });

    const workspaceId = await resolveWorkspaceId(auth.db, auth.userId, body.workspaceId?.trim());
    if (!workspaceId) return NextResponse.json({ error: "No workspace to save this document to." }, { status: 400 });
    const access = await assertSettingsScopeOwned(auth.db, auth.userId, { workspaceId }, { module: "leases", level: "edit" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const { data, error } = await auth.db
      .from("lease_document_library")
      .insert({
        workspace_id: workspaceId,
        manager_user_id: auth.userId,
        name,
        storage_path: storagePath,
        file_name: fileName,
      })
      .select("id, workspace_id, manager_user_id, name, storage_path, file_name, is_default, fields, created_at, updated_at")
      .single();
    if (error || !data) {
      const message = error?.code === "23505" ? "That document is already in the library." : "Could not save the lease document.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
    return NextResponse.json({ entry: toApiEntry(data as LibraryRow) });
  } catch {
    return NextResponse.json({ error: "Could not save the lease document." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      isDefault?: boolean;
      fields?: unknown;
    };
    const id = body.id?.trim();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: existing } = await auth.db
      .from("lease_document_library")
      .select("id, workspace_id")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Lease document not found." }, { status: 404 });
    const access = await assertSettingsScopeOwned(
      auth.db,
      auth.userId,
      { workspaceId: String(existing.workspace_id) },
      { module: "leases", level: "edit" },
    );
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.name === "string") {
      const name = body.name.trim().slice(0, 120);
      if (!name) return NextResponse.json({ error: "Name the lease document." }, { status: 400 });
      patch.name = name;
    }
    if (Array.isArray(body.fields)) {
      patch.fields = normalizeLeaseDocumentFields(body.fields);
    }
    if (body.isDefault === true) {
      // Unset any prior default in the same workspace first — the unique
      // partial index (`lease_document_library_default_per_workspace`) is the
      // authoritative guard; this just avoids racing it into a 500.
      await auth.db
        .from("lease_document_library")
        .update({ is_default: false })
        .eq("workspace_id", existing.workspace_id)
        .eq("is_default", true);
      patch.is_default = true;
    } else if (body.isDefault === false) {
      patch.is_default = false;
    }

    const { data, error } = await auth.db
      .from("lease_document_library")
      .update(patch)
      .eq("id", id)
      .select("id, workspace_id, manager_user_id, name, storage_path, file_name, is_default, fields, created_at, updated_at")
      .single();
    if (error || !data) return NextResponse.json({ error: "Could not update the lease document." }, { status: 502 });
    return NextResponse.json({ entry: toApiEntry(data as LibraryRow) });
  } catch {
    return NextResponse.json({ error: "Could not update the lease document." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = body.id?.trim();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: existing } = await auth.db
      .from("lease_document_library")
      .select("id, workspace_id, storage_path")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ ok: true });
    const access = await assertSettingsScopeOwned(
      auth.db,
      auth.userId,
      { workspaceId: String(existing.workspace_id) },
      { module: "leases", level: "delete" },
    );
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const path = String(existing.storage_path);
    const routeUrl = leaseTemplateUrlForPath(path);

    // Delete-if-unused: a property submission (or a per-property template)
    // referencing the same object path, via the same route URL every listing
    // stores.
    const { data: properties } = await auth.db
      .from("manager_property_records")
      .select("id, property_data")
      .eq("workspace_id", existing.workspace_id);
    const inUseByProperty = (properties ?? []).some((property: { property_data?: unknown }) => {
      const submission = (property.property_data as { listingSubmission?: Record<string, unknown> } | null)?.listingSubmission;
      if (!submission) return false;
      if (submission.leaseTemplateDocUrl === routeUrl) return true;
      const templates = Array.isArray(submission.propertyLeaseTemplates) ? submission.propertyLeaseTemplates : [];
      return templates.some((t: unknown) => (t as { leaseTemplateDocUrl?: unknown })?.leaseTemplateDocUrl === routeUrl);
    });
    if (inUseByProperty) {
      return NextResponse.json({ error: "This lease document is attached to a property. Detach it first." }, { status: 409 });
    }

    // A resident's lease row is attached explicitly via `libraryDocumentId`
    // (`LeasePipelineRow.managerUploadedPdf.libraryDocumentId`), copied on the
    // row at attach time rather than re-derived from the path, because a
    // lease row's own `dataUrl` is inlined base64 bytes, not the route URL.
    // Leases are not workspace-scoped in the schema (only `manager_user_id`),
    // so the check is scoped to the workspace's OWNER — every property/lease
    // in a workspace is filed under its one owning manager account.
    const { data: workspaceRow } = await auth.db
      .from("portal_workspaces")
      .select("owner_user_id")
      .eq("id", existing.workspace_id)
      .maybeSingle();
    const ownerUserId = workspaceRow?.owner_user_id ? String(workspaceRow.owner_user_id) : auth.userId;
    const { data: leases } = await auth.db
      .from("portal_lease_pipeline_records")
      .select("id, row_data")
      .eq("manager_user_id", ownerUserId)
      .limit(1000);
    const inUseByLease = (leases ?? []).some((lease: { row_data?: unknown }) => {
      const pdf = (lease.row_data as { managerUploadedPdf?: { libraryDocumentId?: unknown } } | null)?.managerUploadedPdf;
      return pdf?.libraryDocumentId === id;
    });
    if (inUseByLease) {
      return NextResponse.json({ error: "This lease document is attached to a lease. Detach it first." }, { status: 409 });
    }

    await auth.db.from("lease_document_library").delete().eq("id", id);
    await auth.db.storage.from(LEASE_TEMPLATE_BUCKET).remove([path]).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not delete the lease document." }, { status: 500 });
  }
}
