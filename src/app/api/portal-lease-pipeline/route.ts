import { createHash } from "node:crypto";
import { loadAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { NextResponse } from "next/server";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  fetchLeasesForManagerUser,
  managerCanAccessLeaseRecord,
  managerMayFileLeaseUnderProperty,
  type LeaseScopeRecord,
} from "@/lib/auth/manager-lease-scope";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { autoFileLeaseDocument, type AutoFileLeaseRow } from "@/lib/documents/document-auto-file-hooks.server";
import {
  introducesUntrustedLeaseDocument,
  leaseClaimsExecution,
  leaseAllowsManagerDocumentEdits,
  leaseClaimsExecution,
  leaseDocumentBody,
  leaseDocumentBodyChanged,
  leaseExecutionStripRefusal,
  replacesSignedLeaseDocument,
  wipesExecutedLeaseWithoutSupersedeIntent,
  leaseSignatureRoleForgedBy,
  leaseSignatureWriteRefusal,
  rowHasAnySignature,
  effectiveLeaseDocumentMode,
} from "@/lib/lease-execution-evidence";
import {
  confirmedUploadedLeaseReview,
  normalizeUploadedLeaseParse,
  uploadedLeaseConversionBlocker,
  uploadedLeaseSourceIssueKey,
  uploadedLeaseNeedsManagerConfirmation,
} from "@/lib/uploaded-lease-extraction";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import { parseUploadedLeasePdfBytes } from "@/lib/uploaded-lease-parse.server";
import { assertSafePdfForImport, parsePdfForImport } from "@/lib/pdf-import/pdf-source.server";
import { leaseBodyMatchesManagerFiledLease, managerFiledLeaseScopeForNewRow } from "@/lib/lease-manager-filed-document.server";
import { sanitizeLeaseDocumentHtml, sanitizeManagerLeaseDocumentEdit } from "@/lib/lease-document-sanitizer";
import { LEASE_TEMPLATE_BUCKET, leaseTemplateObjectPath } from "@/lib/lease-template-storage";
import { hasBothLeaseSignatures, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  projectLeasePipelineListRow,
  restoreOmittedLeaseDocument,
} from "@/lib/lease-pipeline-list-projection";
import { syncLeaseLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { buildDurableLeaseTransitionEnvelope, leaseEventForTransition } from "@/lib/domain-action-events.server";

/** The resident-identity scope for this route's two reads; null = match nothing. */
function residentIdentityFilter(user: { id?: string | null; email?: string | null }): string | null {
  return orFilterForIdentity([
    ["resident_user_id", user.id],
    ["resident_email", user.email],
  ]);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pdfDataUrlSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base64 = value.slice(value.indexOf(",") + 1);
  if (!base64 || !/^data:application\/pdf(?:;[^,]*)?,/i.test(value)) return null;
  try {
    return sha256Hex(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
}

function pdfDataUrlBytes(value: string): Uint8Array | null {
  if (!/^data:application\/pdf(?:;[^,]*)?,/i.test(value)) return null;
  const base64 = value.slice(value.indexOf(",") + 1);
  if (!base64) return null;
  try {
    return new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
}

async function verifyLeaseTemplateSource(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  url: string | null | undefined,
  expectedOwnerId: string,
): Promise<{ path: string; sha256: string; bytes: Uint8Array } | null> {
  const path = leaseTemplateObjectPath(url);
  if (!path || path.split("/")[0] !== expectedOwnerId) return null;
  const { data, error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).download(path);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  return { path, sha256: sha256Hex(bytes), bytes };
}

export const runtime = "nodejs";
export const maxDuration = 60;

type RecordUser = { id: string; email?: string | null; name?: string | null; role: string };

async function getUserContext() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, full_name, role").eq("id", user.id).maybeSingle();
  const admin = await isAdminUser(user.id);
  const role = admin
    ? "admin"
    : await resolveResidentScopedActorRole(db, {
        userId: user.id,
        legacyRole: profile?.role ?? user.user_metadata?.role,
      });
  return {
    db,
    user: {
      id: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      name: String(profile?.full_name ?? "").trim() || null,
      role,
    } satisfies RecordUser,
  };
}

function normalizeRow(row: Record<string, unknown>, { sanitizeGeneratedHtml = false }: { sanitizeGeneratedHtml?: boolean } = {}) {
  // A stored document is a string or nothing; anything else reads as nothing so
  // the list projection can type it.
  const stored = typeof row.generatedHtml === "string" ? row.generatedHtml : null;
  const generatedHtml = sanitizeGeneratedHtml && stored ? sanitizeLeaseDocumentHtml(stored) : stored;
  return { ...row, generatedHtml };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** row_data may carry synthetic/demo ids ("demo-resident") — only uuid-shaped
 *  values may reach the uuid column, else the whole upsert 500s. */
function asUuidOrNull(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return UUID_RE.test(v) ? v : null;
}

type StoredLeaseScopeColumns = {
  manager_user_id?: string | null;
  resident_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
};

/**
 * The four columns every scoped query keys on: the resident GET matches
 * `resident_user_id` / `resident_email`, and a manager's pipeline matches
 * `manager_user_id` or a linked `property_id`. Whoever these name is who can
 * see the row, so deriving them from the client row means a request can decide
 * whose lease list it lands in.
 *
 * They are therefore a REQUIRED argument to `buildUpsert` rather than something
 * it reads off the row: every branch must state, in server-resolved terms,
 * whose row it is writing. A branch that forgets no longer inherits a
 * client-controlled default — it fails to compile.
 */
type LeaseScopeColumns = {
  manager_user_id: string | null;
  resident_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
};

/**
 * Scope as the SERVER stored it. Used when the actor may edit a row's body but
 * not who it belongs to.
 *
 * Every key is read from a row the caller's own SELECT must name — see the
 * SELECT-coverage assertion in `lease-pipeline-resident-upsert-scope.test.ts`,
 * because a column missing from that list would silently pin `null` here and
 * orphan the resident from their own lease.
 */
function storedScopeColumns(stored: StoredLeaseScopeColumns | undefined): LeaseScopeColumns {
  return {
    manager_user_id: stored?.manager_user_id ?? null,
    resident_user_id: stored?.resident_user_id ?? null,
    resident_email: stored?.resident_email ?? null,
    property_id: stored?.property_id ?? null,
  };
}

function namedString(row: Record<string, unknown>, camel: string, snake: string): string | null {
  const raw = row[camel] ?? row[snake];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || null;
}

/**
 * The scope fields the CLIENT row actually NAMES, as a partial: a field the row
 * does not name is ABSENT from the result rather than present-as-null, so a
 * caller can fall back to what the server already stored.
 *
 * "Names" means "carries a usable value", not "carries the key". The browser
 * store normalizes `managerUserId` / `residentUserId` to an explicit `null` and
 * drops `propertyId` to `undefined`, so a plain `key in row` test would read a
 * routine full-row sync as an intentional request to CLEAR the scope — which is
 * the wipe this partial exists to prevent. Clearing a scope column is not a
 * product operation; re-pointing one is, and that always carries a value.
 */
function clientNamedScopeParts(row: Record<string, unknown>): Partial<LeaseScopeColumns> {
  const parts: Partial<LeaseScopeColumns> = {};
  const manager = namedString(row, "managerUserId", "manager_user_id");
  if (manager) parts.manager_user_id = manager;
  const residentUser = asUuidOrNull(row.residentUserId ?? row.resident_user_id);
  if (residentUser) parts.resident_user_id = residentUser;
  const residentEmail = namedString(row, "residentEmail", "resident_email");
  if (residentEmail) parts.resident_email = residentEmail;
  const property = namedString(row, "propertyId", "property_id");
  if (property) parts.property_id = property;
  return parts;
}

/**
 * Scope named by the CLIENT row. Legitimate only for an actor who owns the
 * lease: a manager creating or editing one must be able to name the resident it
 * is for. Never reachable from a resident-scoped actor.
 */
function clientNamedScope(row: Record<string, unknown>): LeaseScopeColumns {
  return {
    manager_user_id: null,
    resident_user_id: null,
    resident_email: null,
    property_id: null,
    ...clientNamedScopeParts(row),
  };
}

/**
 * Scope for a row a resident-scoped actor creates. Pinned to the actor so a
 * fabricated row can only ever land in their OWN lease list, never a stranger's
 * (`resident_email` / `resident_user_id`) and never a manager's pipeline
 * (`property_id`, which `fetchLeasesForManagerUser` also matches on for linked
 * properties). `manager_user_id` keeps the caller's own id, as this path has
 * always set it.
 */
function ownResidentScope(user: RecordUser): LeaseScopeColumns {
  return {
    manager_user_id: user.id,
    resident_user_id: asUuidOrNull(user.id),
    resident_email: user.email?.trim().toLowerCase() || null,
    property_id: null,
  };
}

const ROW_SCOPE_MIRRORS = [
  { camel: "managerUserId", snake: "manager_user_id", column: "manager_user_id" },
  { camel: "residentUserId", snake: "resident_user_id", column: "resident_user_id" },
  { camel: "residentEmail", snake: "resident_email", column: "resident_email" },
  { camel: "propertyId", snake: "property_id", column: "property_id" },
] as const satisfies ReadonlyArray<{ camel: string; snake: string; column: keyof LeaseScopeColumns }>;

/**
 * For the four SCOPE keys, and only those, `row_data` is a MIRROR of the scope
 * columns rather than a second source of them. Every other field in `row_data`
 * — `generatedHtml`, `managerUploadedPdf`, `fullySignedAt`, the signatures,
 * `externallySignedLease` — is persisted verbatim as the client sent it, so a
 * stored value there is prior-request client input and never evidence the server
 * established. Anything making a trust decision has to corroborate it.
 *
 * Pinning the columns alone left a laundering chute one hop wide: the columns
 * are what scoped queries key on, but `row_data` is what the manager's browser
 * store reads back from GET and re-sends on its next `replace` sync — where
 * `clientNamedScopeParts` would promote it straight into the columns. So a
 * resident who may edit the BODY of their own lease could write
 * `row_data.residentEmail` = a stranger and have the manager's own client
 * launder it into `resident_email` on the next save.
 *
 * The reconciliation: a scope key in `row_data` is overwritten with the
 * server-resolved column whenever that column has a value. When it does not,
 * an EXISTING row keeps what the server already stored (so the client copy can
 * never be the thing that changes it), while a brand-new row keeps the
 * creator's value — a row with no prior scope has nothing to launder, and its
 * columns are server-resolved regardless. The snake_case aliases are dropped
 * outright so they cannot smuggle a value past the camelCase mirror.
 */
function reconcileRowScope(
  row: Record<string, unknown>,
  scope: LeaseScopeColumns,
  storedRow: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out = { ...row };
  for (const { camel, snake, column } of ROW_SCOPE_MIRRORS) {
    delete out[snake];
    const resolved = scope[column];
    if (resolved) {
      out[camel] = resolved;
      continue;
    }
    if (!storedRow) continue;
    const stored = storedRow[camel];
    if (stored === undefined) delete out[camel];
    else out[camel] = stored;
  }
  return out;
}

function buildUpsert(
  row: Record<string, unknown>,
  scope: LeaseScopeColumns,
  storedRow: Record<string, unknown> | undefined,
) {
  const rowData = reconcileRowScope(row, scope, storedRow);
  return {
    id: row.id,
    manager_user_id: scope.manager_user_id,
    resident_user_id: scope.resident_user_id,
    resident_email: scope.resident_email,
    property_id: scope.property_id,
    status: row.bucket ?? row.status ?? null,
    row_data: rowData,
    updated_at: new Date().toISOString(),
  };
}

type LeaseRecordForRead = LeaseScopeRecord & {
  resident_email?: string | null;
  resident_user_id?: string | null;
};

function rowFromLeaseRecord(record: LeaseScopeRecord): Record<string, unknown> {
  const row = (record.row_data && typeof record.row_data === "object" ? record.row_data : record) as Record<
    string,
    unknown
  >;
  return { ...row, reviewRevision: (record as LeaseScopeRecord & { updated_at?: string | null }).updated_at ?? null };
}

async function viewerMayReadLeaseRecord(
  ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; user: RecordUser },
  record: LeaseRecordForRead,
): Promise<boolean> {
  if (ctx.user.role === "admin") return true;
  if (ctx.user.role === "resident") {
    const email = (record.resident_email ?? "").trim().toLowerCase();
    const residentUserId = (record.resident_user_id ?? "").trim();
    return Boolean(
      (ctx.user.email && email && email === ctx.user.email) ||
        (ctx.user.id && residentUserId && residentUserId === ctx.user.id),
    );
  }
  return managerCanAccessLeaseRecord(ctx.db, ctx.user.id, record);
}

export async function GET(req: Request) {
  try {
    const ctx = await getUserContext();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const id = req?.url ? new URL(req.url).searchParams.get("id")?.trim() ?? "" : "";
    if (id) {
      const { data, error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, row_data, updated_at, manager_user_id, property_id, resident_email, resident_user_id")
        .eq("id", id)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const record = data as LeaseRecordForRead;
      if (!(await viewerMayReadLeaseRecord(ctx, record))) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      return NextResponse.json({ rows: [normalizeRow(rowFromLeaseRecord(record))] });
    }

    let records: LeaseScopeRecord[] = [];

    if (ctx.user.role === "admin") {
      const { data, error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, row_data, updated_at")
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      records = (data ?? []) as LeaseScopeRecord[];
    } else if (ctx.user.role === "resident") {
      // A resident with no identity sees nothing — never an unscoped read of a
      // table that holds every manager's leases.
      const residentScope = residentIdentityFilter(ctx.user);
      if (!residentScope) return NextResponse.json({ rows: [] });
      const { data, error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, row_data, updated_at")
        .or(residentScope)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      records = (data ?? []) as LeaseScopeRecord[];
    } else {
      records = await fetchLeasesForManagerUser(ctx.db, ctx.user.id);
    }

    const rows = records.map((record) =>
      projectLeasePipelineListRow(normalizeRow(rowFromLeaseRecord(record)) as LeasePipelineRow),
    );

    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await getUserContext();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "deleteIds" | "replace" | "confirm_template_placement_review" | "confirm_uploaded_lease_review";
      id?: string;
      leaseId?: string;
      acknowledgeTermsRiderConflicts?: boolean;
      uploadedReview?: {
        overrides?: Record<string, unknown>;
        note?: string | null;
        useConverted?: boolean;
        convertedHtml?: string;
        resolvedSourceIssueCodes?: string[];
        expectedRevision?: string | null;
        viewedSourceSha256?: string;
        viewedConvertedHtmlSha256?: string | null;
        viewedRecordFingerprint?: string;
      };
      expectedReview?: { revision?: string | null; sourceSha256?: string; finalHtmlSha256?: string; recordFingerprint?: string };
      ids?: unknown[];
      row?: Record<string, unknown>;
      rows?: Record<string, unknown>[];
    };

    if (body.action === "confirm_template_placement_review") {
      if (ctx.user.role === "resident") return NextResponse.json({ error: "Not found." }, { status: 404 });
      const leaseId = body.leaseId?.trim() ?? "";
      if (!leaseId) return NextResponse.json({ error: "Lease id required." }, { status: 400 });
      const { data, error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, manager_user_id, resident_user_id, resident_email, property_id, row_data, updated_at")
        .eq("id", leaseId)
        .limit(1);
      if (error) return NextResponse.json({ error: "Could not load lease review." }, { status: 500 });
      const record = (data ?? [])[0] as (LeaseScopeRecord & StoredLeaseScopeColumns & { row_data?: Record<string, unknown>; updated_at?: string | null }) | undefined;
      if (!record || (ctx.user.role !== "admin" && !(await managerCanAccessLeaseRecord(ctx.db, ctx.user.id, record, "edit")))) {
        return NextResponse.json({ error: "Lease not found." }, { status: 404 });
      }
      const row = normalizeRow(record.row_data ?? {}) as unknown as LeasePipelineRow;
      if (
        effectiveLeaseDocumentMode(row) !== "imported-converted" ||
        !row.templateImportReview ||
        !row.generatedHtml ||
        rowHasAnySignature(row) ||
        row.status !== "Manager Review"
      ) return NextResponse.json({ error: "This lease is not ready for imported-template review." }, { status: 409 });
      if (body.acknowledgeTermsRiderConflicts !== true) {
        return NextResponse.json({ error: "Review and acknowledge any differences in the appended PropLane Terms Rider." }, { status: 409 });
      }
      if (row.templateImportReview.issueCodes.includes("unreadable_page") && !row.templateImportReview.resolvedIssueCodes.includes("unreadable_page")) {
        return NextResponse.json({ error: "Transcribe unreadable source pages in the converted template first." }, { status: 409 });
      }
      const source = await verifyLeaseTemplateSource(ctx.db, row.templateDocumentUrl ?? "", record.manager_user_id ?? "");
      if (!source || source.sha256 !== row.templateImportReview.sourceSha256) {
        return NextResponse.json({ error: "The original lease template no longer matches its reviewed source." }, { status: 409 });
      }
      let parsedSource;
      try {
        parsedSource = await parsePdfForImport({ bytes: source.bytes, fileName: row.templateDocumentName ?? "lease.pdf" });
      } catch {
        return NextResponse.json({ error: "The original lease template could not be read. Reimport it before sending." }, { status: 409 });
      }
      const actualIssueCodes = parsedSource.issues.map((issue) => issue.code).sort();
      const recordedIssueCodes = [...row.templateImportReview.issueCodes].sort();
      if (
        parsedSource.sourceSha256 !== source.sha256 ||
        !parsedSource.coverage.complete ||
        JSON.stringify(actualIssueCodes) !== JSON.stringify(recordedIssueCodes) ||
        parsedSource.coverage.extractedCharacters !== row.templateImportReview.extractedCharacters ||
        parsedSource.coverage.representedCharacters !== row.templateImportReview.representedCharacters
      ) return NextResponse.json({ error: "The source reading changed. Reimport and review the original lease template." }, { status: 409 });
      const sanitizedHtml = sanitizeLeaseDocumentHtml(row.generatedHtml);
      if (sanitizedHtml !== row.generatedHtml) {
        return NextResponse.json({ error: "The placement lease changed during review. Reopen it and compare the current version." }, { status: 409 });
      }
      if (
        body.expectedReview?.revision !== (record.updated_at ?? null) ||
        body.expectedReview.sourceSha256 !== source.sha256 ||
        body.expectedReview.finalHtmlSha256 !== sha256Hex(sanitizedHtml) ||
        body.expectedReview.recordFingerprint !== leaseRecordFingerprint({
          residentName: row.residentName,
          leaseStart: row.application?.leaseStart ?? null,
          leaseEnd: row.application?.leaseEnd ?? null,
          rentLabel: row.signedRentLabel ?? null,
        })
      ) return NextResponse.json({ error: "The lease changed during review. Reopen the comparison." }, { status: 409 });
      const templatePlacementReview = {
        sourceSha256: source.sha256,
        sourcePath: source.path,
        finalHtmlSha256: sha256Hex(sanitizedHtml),
        templateVersion: row.templateImportReview.templateVersion,
        reviewedAtIso: new Date().toISOString(),
        confirmedByUserId: ctx.user.id,
        riderConflictAcknowledged: true,
      };
      const nextRow = { ...row, templatePlacementReview };
      let updateReview = ctx.db
        .from("portal_lease_pipeline_records")
        .update({ row_data: nextRow, updated_at: new Date().toISOString() })
        .eq("id", leaseId)
        .eq("manager_user_id", record.manager_user_id);
      updateReview = record.updated_at
        ? updateReview.eq("updated_at", record.updated_at)
        : updateReview.is("updated_at", null);
      const { data: updatedRows, error: updateError } = await updateReview.select("id");
      if (updateError) return NextResponse.json({ error: "Could not save the lease review." }, { status: 500 });
      if (!updatedRows?.length) return NextResponse.json({ error: "The lease changed during review. Reopen it and compare the current version." }, { status: 409 });
      return NextResponse.json({ ok: true, row: nextRow });
    }

    if (body.action === "confirm_uploaded_lease_review") {
      if (ctx.user.role === "resident") return NextResponse.json({ error: "Not found." }, { status: 404 });
      const leaseId = body.leaseId?.trim() ?? "";
      if (!leaseId) return NextResponse.json({ error: "Lease id required." }, { status: 400 });
      const { data, error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, manager_user_id, resident_user_id, resident_email, property_id, row_data, updated_at")
        .eq("id", leaseId)
        .limit(1);
      if (error) return NextResponse.json({ error: "Could not load lease review." }, { status: 500 });
      const record = (data ?? [])[0] as (LeaseScopeRecord & StoredLeaseScopeColumns & { row_data?: Record<string, unknown>; updated_at?: string | null }) | undefined;
      if (!record || (ctx.user.role !== "admin" && !(await managerCanAccessLeaseRecord(ctx.db, ctx.user.id, record, "edit")))) {
        return NextResponse.json({ error: "Lease not found." }, { status: 404 });
      }
      const row = normalizeRow(record.row_data ?? {}) as unknown as LeasePipelineRow;
      const storedParse = normalizeUploadedLeaseParse(row.uploadedLeaseParse);
      const pdf = row.managerUploadedPdf;
      if (!storedParse || !pdf?.dataUrl || rowHasAnySignature(row) || row.status !== "Manager Review") {
        return NextResponse.json({ error: "This uploaded lease is not ready for review." }, { status: 409 });
      }
      const sourceDataUrl = pdf.originalDataUrl ?? pdf.dataUrl;
      const sourceSha256 = pdfDataUrlSha256(sourceDataUrl);
      if (!sourceSha256 || sourceSha256 !== storedParse.sourceSha256) {
        return NextResponse.json({ error: "The imported reading does not match the original PDF." }, { status: 409 });
      }
      const recordFingerprint = leaseRecordFingerprint({
        residentName: row.residentName,
        leaseStart: row.application?.leaseStart ?? null,
        leaseEnd: row.application?.leaseEnd ?? null,
        rentLabel: row.signedRentLabel ?? null,
      });
      const viewedHtmlSha256 = body.uploadedReview?.useConverted
        ? sha256Hex(sanitizeLeaseDocumentHtml(body.uploadedReview.convertedHtml?.trim() ?? "") ?? "")
        : null;
      if (
        body.uploadedReview?.expectedRevision !== (record.updated_at ?? null) ||
        body.uploadedReview.viewedSourceSha256 !== sourceSha256 ||
        body.uploadedReview.viewedConvertedHtmlSha256 !== viewedHtmlSha256 ||
        body.uploadedReview.viewedRecordFingerprint !== recordFingerprint
      ) return NextResponse.json({ error: "The lease changed during review. Reopen the comparison." }, { status: 409 });
      const parse = await parseUploadedLeasePdfBytes({
        bytes: new Uint8Array(Buffer.from(sourceDataUrl.slice(sourceDataUrl.indexOf(",") + 1), "base64")),
        fileName: pdf.fileName,
        nowIso: storedParse.extractedAtIso ?? undefined,
      });
      if (parse.sourceSha256 !== sourceSha256) {
        return NextResponse.json({ error: "The imported reading does not match the original PDF." }, { status: 409 });
      }
      if (body.uploadedReview?.useConverted) {
        const blocker = uploadedLeaseConversionBlocker(parse, body.uploadedReview.resolvedSourceIssueCodes ?? []);
        if (blocker || !body.uploadedReview.convertedHtml?.trim()) return NextResponse.json({ error: blocker ?? "The converted lease is empty." }, { status: 409 });
      }
      const convertedHtml = body.uploadedReview?.useConverted
        ? sanitizeLeaseDocumentHtml(body.uploadedReview.convertedHtml?.trim() ?? "")
        : row.generatedHtml ?? null;
      const convertedHtmlSha256 = body.uploadedReview?.useConverted && convertedHtml
        ? sha256Hex(convertedHtml)
        : null;
      const knownSourceIssueCodes = new Set((parse.sourceIssues ?? []).map(uploadedLeaseSourceIssueKey));
      const resolvedSourceIssueCodes = body.uploadedReview?.useConverted
        ? [...new Set((body.uploadedReview.resolvedSourceIssueCodes ?? []).filter((value): value is string => typeof value === "string" && knownSourceIssueCodes.has(value)))].slice(0, 120)
        : [];
      const overrides: Record<string, string> = {};
      const knownFieldKeys = new Set<string>(parse.fields.map((field) => field.key));
      for (const [key, value] of Object.entries(body.uploadedReview?.overrides ?? {})) {
        if (knownFieldKeys.has(key) && typeof value === "string" && value.trim()) overrides[key] = value.trim().slice(0, 500);
      }
      const reviewedAtIso = new Date().toISOString();
      const review = confirmedUploadedLeaseReview(
        { ...parse.review, overrides: Object.keys(overrides).length ? overrides : undefined },
        {
          userId: ctx.user.id,
          name: ctx.user.name,
          atIso: reviewedAtIso,
          note: body.uploadedReview?.note,
          documentSha256: sourceSha256,
          convertedHtmlSha256,
          resolvedSourceIssueCodes,
          recordFingerprint,
        },
      );
      const nextRow = {
        ...row,
        generatedHtml: convertedHtml,
        documentMode: body.uploadedReview?.useConverted ? "imported-converted" : "original-pdf",
        versionNumber: body.uploadedReview?.useConverted && convertedHtml !== row.generatedHtml ? (row.versionNumber ?? row.pdfVersion ?? 1) + 1 : row.versionNumber,
        pdfVersion: body.uploadedReview?.useConverted && convertedHtml !== row.generatedHtml ? (row.versionNumber ?? row.pdfVersion ?? 1) + 1 : row.pdfVersion,
        generatedAtIso: body.uploadedReview?.useConverted && convertedHtml !== row.generatedHtml ? reviewedAtIso : row.generatedAtIso,
        managerDocumentEditedAtIso: body.uploadedReview?.useConverted && convertedHtml !== row.generatedHtml ? reviewedAtIso : row.managerDocumentEditedAtIso,
        uploadedLeaseParse: { ...parse, review },
        uploadedLeaseReviewReceipt: {
          sourceSha256,
          documentSha256: sourceSha256,
          convertedHtmlSha256,
          resolvedSourceIssueCodes,
          reviewedAtIso,
          confirmedByUserId: ctx.user.id,
        },
      };
      let updateReview = ctx.db
        .from("portal_lease_pipeline_records")
        .update({ row_data: nextRow, updated_at: reviewedAtIso })
        .eq("id", leaseId)
        .eq("manager_user_id", record.manager_user_id);
      updateReview = record.updated_at
        ? updateReview.eq("updated_at", record.updated_at)
        : updateReview.is("updated_at", null);
      const { data: updatedRows, error: updateError } = await updateReview.select("id");
      if (updateError) return NextResponse.json({ error: "Could not save the lease review." }, { status: 500 });
      if (!updatedRows?.length) return NextResponse.json({ error: "The lease changed during review. Reopen it and compare the current version." }, { status: 409 });
      return NextResponse.json({ ok: true, row: nextRow });
    }

    if (body.action === "delete" || body.action === "deleteIds") {
      const ids =
        body.action === "deleteIds"
          ? (Array.isArray(body.ids) ? body.ids.map(String) : [])
          : [body.id?.trim() ?? ""];
      if (ids.length === 0 || ids.some((id) => !id)) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      if (ctx.user.role === "resident") {
        return NextResponse.json({ error: "Residents cannot delete lease records." }, { status: 403 });
      }
      const executedIds: string[] = [];
      for (const id of ids) {
        const { data: existing } = await ctx.db
          .from("portal_lease_pipeline_records")
          .select("id, manager_user_id, property_id, row_data")
          .eq("id", id)
          .limit(1);
        const record = (existing ?? [])[0] as (LeaseScopeRecord & { row_data?: Record<string, unknown> }) | undefined;
        if (!record) continue;
        if (ctx.user.role !== "admin") {
          const allowed = await managerCanAccessLeaseRecord(ctx.db, ctx.user.id, record, "delete");
          if (!allowed) continue;
        }
        // A fully executed lease is legal evidence: permanently deleting the row
        // destroys the signed document and both signatures with no way to recover
        // them, and unlike a routine save (guarded above by
        // `wipesExecutedLeaseWithoutSupersedeIntent`) a DELETE has no "supersede"
        // shape to exempt. Refuse rather than archive-by-accident; the manager
        // still has void/renew for a lease they no longer want active.
        const storedRow = (record.row_data ?? {}) as LeasePipelineRow;
        if (leaseClaimsExecution(storedRow)) {
          executedIds.push(id);
          continue;
        }
        await ctx.db.from("portal_lease_pipeline_records").delete().eq("id", id);
      }
      // Bulk (`deleteIds`) callers today are fire-and-forget local-cache cleanup
      // (e.g. purging an application's draft leases) and do not inspect this
      // body, so a single executed id never blocks the rest of the batch — but
      // the refusal is still real: `refused` lists every id whose row survives.
      if (executedIds.length > 0) {
        return NextResponse.json({
          ok: true,
          refused: executedIds,
          error: "This lease is executed and cannot be deleted. Void or renew it instead.",
        });
      }
      return NextResponse.json({ ok: true });
    }

    const rows = body.action === "replace" ? (body.rows ?? []) : body.row ? [body.row] : [];
    if (rows.length === 0) return NextResponse.json({ error: "row required" }, { status: 400 });

    /**
     * A client-named `property_id` is only honored when the caller owns or is
     * linked to that property. An unchanged value is not a move, so a row whose
     * property was since deleted still saves.
     *
     * Refusal is reserved for a property that PROVABLY belongs to someone else.
     * An id with no `manager_property_records` row at all — a deleted listing,
     * or an id that was never persisted as a property record — is not evidence
     * of a takeover, and refusing it would 403 an ordinary save: the browser
     * store posts the manager's ENTIRE row set as one `replace`, so a single
     * such row would take the whole batch down with it.
     */
    const refuseUnownedProperty = async (
      namedPropertyId: string | null,
      storedPropertyId: string | null | undefined,
    ): Promise<NextResponse | null> => {
      const named = String(namedPropertyId ?? "").trim();
      if (!named || named === String(storedPropertyId ?? "").trim()) return null;
      const check = await managerMayFileLeaseUnderProperty(ctx.db, ctx.user.id, named);
      if (!check.ok) {
        return NextResponse.json({ error: "Could not verify property ownership." }, { status: 500 });
      }
      if (!check.allowed && check.propertyExists) {
        return NextResponse.json({ error: "That property is not yours to file a lease under." }, { status: 403 });
      }
      return null;
    };

    /**
     * Every row is authorized and resolved BEFORE any row is written. The check
     * used to run inside the write loop, so a refusal on the last row of a
     * `replace` left the earlier rows already upserted — a partial write, with
     * a 403 that named no row. Validation and persistence are therefore two
     * passes: nothing is written unless the whole batch is allowed.
     */
    const planned = new Map<
      string,
      {
        row: Record<string, unknown>;
        record: ReturnType<typeof buildUpsert>;
        previouslySigned: boolean;
        untrustedDocument: boolean;
        previousRow: LeasePipelineRow | null;
        expectedUpdatedAt: string | null;
      }
    >();

    for (const row of rows) {
      // Sanitization is deferred until we can compare against the stored body: rewriting an
      // UNCHANGED body on an unrelated save silently mutates a signed lease's evidence bytes,
      // and the certificate's hash describes those exact bytes.
      let normalized: Record<string, unknown> = normalizeRow(row);
      if (!normalized.id) return NextResponse.json({ error: "row id required" }, { status: 400 });
      const id = String(normalized.id);

      const { data: existing, error: existingError } = await ctx.db
        .from("portal_lease_pipeline_records")
        .select("id, manager_user_id, resident_user_id, resident_email, property_id, row_data, updated_at")
        .eq("id", id)
        .limit(1);
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

      const recordExists = Array.isArray(existing) && existing.length > 0;
      const existingRecord = (existing ?? [])[0] as
        | (LeaseScopeRecord & StoredLeaseScopeColumns & { row_data?: Record<string, unknown>; updated_at?: string | null })
        | undefined;

      // The client edit helper restores P7 verbatim blocks too, but this is a
      // public route. Re-run that comparison against the stored source before
      // accepting a manager-authored replacement from devtools or another
      // client, then build the row_data payload from the restored value.
      const storedForSanitization = existingRecord?.row_data as LeasePipelineRow | undefined;
      const storedGeneratedHtml = typeof storedForSanitization?.generatedHtml === "string" ? storedForSanitization.generatedHtml : null;
      const incomingHasGeneratedHtml = Object.hasOwn(row, "generatedHtml");
      const incomingClearsSignatures = Boolean(
        storedForSanitization && rowHasAnySignature(storedForSanitization) && !rowHasAnySignature(normalized as LeasePipelineRow),
      );
      // EVERY body that differs from the stored one is sanitized, whatever else the write does.
      // Making this conditional on `!incomingClearsSignatures` meant a request that nulled the
      // signatures stored raw HTML, which removed the server half of the XSS defense and let a
      // manager drop every statutory clause with no trick at all. Only an exact echo of the
      // stored body is left alone, because rewriting an UNCHANGED body silently mutates the
      // evidence bytes a signed lease's certificate hash describes.
      if (incomingHasGeneratedHtml && row.generatedHtml != null && typeof row.generatedHtml !== "string") {
        return NextResponse.json({ error: "Lease document must be text." }, { status: 400 });
      }
      const bodyDiffersFromStored =
        typeof row.generatedHtml === "string" && row.generatedHtml !== storedGeneratedHtml;
      // The clause gate runs whenever there IS a stored body, including a write that clears the
      // signatures. Exempting that path let a manager drop every statutory disclosure simply by
      // nulling the signatures in the same request. A legitimate renewal or amendment carries a
      // freshly generated body for the same property, so it still contains those clauses and
      // passes; a body that merely deletes them does not.
      const editableAgainstStored = Boolean(storedGeneratedHtml);
      if (bodyDiffersFromStored && !editableAgainstStored) {
        const cleaned = sanitizeLeaseDocumentHtml(row.generatedHtml as string);
        if (cleaned !== row.generatedHtml) {
          normalized = { ...normalized, generatedHtml: cleaned };
        }
      }
      if (storedGeneratedHtml && incomingHasGeneratedHtml) {
        // Removing the body is judged once, further down, where the signature-clearing
        // exemption is also in scope — a resident uploading their own signed PDF legitimately
        // nulls `generatedHtml`, and refusing it here would have made that write unreachable.
        if (typeof row.generatedHtml === "string" && row.generatedHtml !== storedGeneratedHtml) {
          // Only a body that actually CHANGED is a manager edit, and only that is sanitized.
          // Echoing the stored body back is left byte-identical so an unrelated save cannot
          // rewrite an executed lease underneath its own signature hash.
          const sanitized = sanitizeManagerLeaseDocumentEdit(storedGeneratedHtml, row.generatedHtml);
          if (!sanitized.ok) return NextResponse.json({ error: sanitized.error }, { status: 400 });
          normalized = { ...normalized, generatedHtml: sanitized.html };
        }
      }

      // Evidence integrity, authoritative copy. The client store runs the same
      // predicate, but it runs IN the browser against a store the browser owns,
      // so it is advisory: this route is where a signed lease's document body
      // actually becomes immutable. Refuse rather than silently restore, because a
      // legitimate client never replaces the body of a row that still carries a
      // signature, so a request that does is either tampering or a bug, and
      // both deserve to surface. Admins are not exempt; the point is that the
      // executed text cannot change, not that only strangers may not change it.
      const storedRow = existingRecord?.row_data as LeasePipelineRow | undefined;
      const submittedPdf = normalized.managerUploadedPdf as LeasePipelineRow["managerUploadedPdf"];
      const priorPdf = storedRow?.managerUploadedPdf;
      for (const field of ["dataUrl", "originalDataUrl"] as const) {
        const submittedBytes = submittedPdf?.[field];
        const previousBytes = priorPdf?.[field];
        if (typeof submittedBytes !== "string" || !submittedBytes || submittedBytes === previousBytes) continue;
        const decoded = pdfDataUrlBytes(submittedBytes);
        if (!decoded) return NextResponse.json({ error: "Uploaded lease must be a valid PDF data URL." }, { status: 400 });
        try {
          await assertSafePdfForImport(decoded);
        } catch {
          return NextResponse.json({ error: "This PDF contains active content and cannot be stored as a lease." }, { status: 400 });
        }
      }
      // A list-shaped client row has filenames only. Putting those bytes
      // back here means an ordinary save cannot 409 as a document replacement
      // and cannot empty the stored PDF.
      if (storedRow) {
        normalized = restoreOmittedLeaseDocument(storedRow, normalized as LeasePipelineRow) as Record<
          string,
          unknown
        >;
        normalized.templatePlacementReview = storedRow.templatePlacementReview ?? null;
        // Imported-template provenance is server-owned once the row exists. A
        // body edit invalidates its placement receipt below, but it cannot turn
        // an imported lease into a generated lease by clearing client fields.
        // A new source/template must enter through an explicit import flow.
        if (storedRow.templateImportReview) {
          const requestedReview = (normalizeRow(row) as unknown as LeasePipelineRow).templateImportReview;
          const provenanceChanged =
            !requestedReview ||
            requestedReview.sourceSha256 !== storedRow.templateImportReview.sourceSha256 ||
            requestedReview.templateVersion !== storedRow.templateImportReview.templateVersion ||
            row.templateDocumentUrl !== storedRow.templateDocumentUrl ||
            row.documentMode !== storedRow.documentMode;
          if (provenanceChanged) {
            return NextResponse.json({ error: "Imported lease provenance can only change through a reviewed import transition." }, { status: 409 });
          }
          normalized.templateImportReview = storedRow.templateImportReview;
          normalized.templateDocumentUrl = storedRow.templateDocumentUrl ?? null;
          normalized.templateVersion = storedRow.templateVersion ?? null;
          if (
            !storedRow.managerUploadedPdf?.dataUrl &&
            !storedRow.uploadedLeaseParse &&
            ((normalized.managerUploadedPdf as LeasePipelineRow["managerUploadedPdf"] | null | undefined)?.dataUrl ||
              (normalized.managerUploadedPdf as LeasePipelineRow["managerUploadedPdf"] | null | undefined)?.originalDataUrl)
          ) {
            return NextResponse.json({ error: "A reusable template placement cannot be replaced by uploaded lease bytes." }, { status: 409 });
          }
        } else {
          normalized.templateImportReview = null;
          normalized.templatePlacementReview = null;
        }
        // For the same uploaded bytes, omission/null is not a way to remove the
        // server's parse and its review state. Replacing the PDF requires a new
        // parse to be present with that upload.
        const storedPdf = storedRow.managerUploadedPdf;
        const nextPdf = normalized.managerUploadedPdf as LeasePipelineRow["managerUploadedPdf"];
        const storedOriginal = storedPdf?.originalDataUrl ?? storedPdf?.dataUrl ?? null;
        const nextOriginal = nextPdf?.originalDataUrl ?? nextPdf?.dataUrl ?? null;
        const sameUploadedSource = Boolean(storedOriginal && nextOriginal === storedOriginal && nextPdf?.dataUrl === storedPdf?.dataUrl);
        const storedParse = normalizeUploadedLeaseParse(storedRow.uploadedLeaseParse);
        const incomingParse = normalizeUploadedLeaseParse(normalized.uploadedLeaseParse);
        const importedSource = Boolean(storedOriginal && (storedParse || storedRow.uploadedLeaseReviewReceipt || storedRow.documentMode === "imported-converted"));
        if (importedSource && !nextOriginal) {
          return NextResponse.json({ error: "An imported lease source cannot be removed through this save path." }, { status: 409 });
        }
        if (importedSource && !sameUploadedSource) {
          // A genuinely new PDF may be uploaded while the lease is unsigned and
          // in manager review. Its review starts over; the client cannot carry
          // the old receipt or downgrade the old source into a generated lease.
          if (
            ctx.user.role === "resident" ||
            rowHasAnySignature(storedRow) ||
            storedRow.fullySignedAt ||
            normalized.status !== "Manager Review" ||
            !nextPdf?.dataUrl || nextPdf.originalDataUrl !== nextPdf.dataUrl ||
            !incomingParse || incomingParse.review.status === "confirmed" ||
            (incomingParse.sourceSha256 && incomingParse.sourceSha256 !== pdfDataUrlSha256(nextOriginal))
          ) return NextResponse.json({ error: "A new uploaded lease requires an unsigned manager-review replacement and fresh reading." }, { status: 409 });
          normalized.documentMode = "original-pdf";
        }
        if (importedSource && sameUploadedSource) {
          if (normalized.documentMode !== storedRow.documentMode) {
            return NextResponse.json({ error: "The imported lease mode can only change through a reviewed transition." }, { status: 409 });
          }
          normalized.managerUploadedPdf = storedPdf;
        }
        if (sameUploadedSource && storedParse && !uploadedLeaseNeedsManagerConfirmation(storedParse)) {
          // Once confirmed, the reading and its human decision are server-owned.
          normalized.uploadedLeaseParse = storedParse;
        } else if (incomingParse) {
          // A browser may save a fresh unconfirmed parse, but cannot claim a
          // review happened. The separate action below issues the receipt.
          normalized.uploadedLeaseParse = {
            ...incomingParse,
            review: {
              ...incomingParse.review,
              status: "needs_review",
              confirmedByUserId: null,
              confirmedByName: null,
              confirmedAtIso: null,
              confirmedDocumentSha256: null,
              confirmedConvertedHtmlSha256: null,
              resolvedSourceIssueCodes: [],
              confirmedRecordFingerprint: null,
            },
          };
        } else if (sameUploadedSource && storedParse) {
          normalized.uploadedLeaseParse = storedParse;
        }
        const receipt = storedRow.uploadedLeaseReviewReceipt;
        const bodyStillReviewed =
          normalized.generatedHtml === storedRow.generatedHtml &&
          normalized.documentMode === storedRow.documentMode;
        normalized.uploadedLeaseReviewReceipt = sameUploadedSource && bodyStillReviewed ? receipt ?? null : null;
        if (sameUploadedSource && storedParse && !normalized.uploadedLeaseParse) {
          normalized.uploadedLeaseParse = storedParse;
        }
      } else {
        // Placement receipts are issued only by the dedicated confirmation
        // action below; a generic create cannot plant one for a later send.
        normalized.templatePlacementReview = null;
        normalized.uploadedLeaseReviewReceipt = null;
        const incomingParse = normalizeUploadedLeaseParse(normalized.uploadedLeaseParse);
        if (incomingParse) {
          normalized.uploadedLeaseParse = {
            ...incomingParse,
            review: {
              ...incomingParse.review,
              status: "needs_review",
              confirmedByUserId: null,
              confirmedByName: null,
              confirmedAtIso: null,
              confirmedDocumentSha256: null,
              confirmedConvertedHtmlSha256: null,
              resolvedSourceIssueCodes: [],
              confirmedRecordFingerprint: null,
            },
          };
        }
      }
      if (storedRow && replacesSignedLeaseDocument(storedRow, normalized as unknown as LeasePipelineRow)) {
        return NextResponse.json(
          { error: "This lease already carries a signature; its document cannot be replaced." },
          { status: 409 },
        );
      }

      if (storedRow) {
        const executionStripRefusal = leaseExecutionStripRefusal(storedRow, normalized as unknown as LeasePipelineRow);
        if (executionStripRefusal) {
          return NextResponse.json({ error: executionStripRefusal }, { status: 409 });
        }
      }

      if (
        normalized.status === "Fully Signed" &&
        storedRow?.status !== "Fully Signed" &&
        (!normalized.fullySignedAt || !hasBothLeaseSignatures(normalized as LeasePipelineRow))
      ) {
        return NextResponse.json({ error: "A fully signed lease requires both parties' signatures." }, { status: 409 });
      }

      // A new row has no prior document or signing state to compare with. An
      // executed first write is valid only for the PDF already filed by this
      // manager on an application. Otherwise a client could create a forged
      // fully signed lease and have it auto-filed in the same request.
      let filedFirstWriteScope: { managerUserId: string; residentEmail: string; propertyId: string | null } | null = null;
      if (
        !storedRow &&
        (leaseClaimsExecution(normalized as LeasePipelineRow) || normalized.externallySignedLease === true || normalized.status === "Fully Signed")
      ) {
        const candidatePdf = normalized.managerUploadedPdf as LeasePipelineRow["managerUploadedPdf"];
        const body = {
          html: typeof normalized.generatedHtml === "string" ? normalized.generatedHtml : null,
          pdf: leaseDocumentBody(normalized as unknown as LeasePipelineRow).pdf,
        };
        const shapeMatchesOnboarding =
          normalized.externallySignedLease === true &&
          Boolean(normalized.fullySignedAt) &&
          hasBothLeaseSignatures(normalized as LeasePipelineRow) &&
          effectiveLeaseDocumentMode(normalized as LeasePipelineRow) === "original-pdf" &&
          normalized.id === `lease_app_${normalized.axisId}` &&
          (!candidatePdf?.originalDataUrl || candidatePdf.originalDataUrl === candidatePdf.dataUrl);
        if (shapeMatchesOnboarding && (ctx.user.role === "manager" || ctx.user.role === "resident")) {
          filedFirstWriteScope = await managerFiledLeaseScopeForNewRow(
            ctx.db,
            typeof normalized.axisId === "string" ? normalized.axisId : null,
            { role: ctx.user.role, id: ctx.user.id, email: ctx.user.email },
            body,
          );
        }
        if (!filedFirstWriteScope) {
          return NextResponse.json(
            { error: "A new executed lease must match the signed PDF filed by its manager." },
            { status: 409 },
          );
        }
        const submittedResidentEmail = String(normalized.residentEmail ?? "").trim().toLowerCase();
        const submittedPropertyId = String(normalized.propertyId ?? "").trim();
        if (
          (submittedResidentEmail && submittedResidentEmail !== filedFirstWriteScope.residentEmail) ||
          (submittedPropertyId && submittedPropertyId !== (filedFirstWriteScope.propertyId ?? ""))
        ) {
          return NextResponse.json({ error: "Lease scope must match the filed application." }, { status: 409 });
        }
        if (ctx.user.role === "manager") {
          // The application is linked by verified email. A client-supplied
          // UUID must not create a second resident reader of the signed PDF,
          // including through row_data on a later manager sync.
          normalized = { ...normalized, residentUserId: null };
        }
      }

      // ONE trust decision, read by the resident guard below and by auto-file:
      // does this write claim execution of a document body the server did not
      // already hold? The pure predicate never reads a flag out of the request;
      // the one legitimate shape that introduces a body — the existing-resident
      // onboarding lease `syncApprovedApplications` seeds, which the RESIDENT's
      // browser also materializes — is admitted only by matching the bytes the
      // manager filed on the application record, keyed on the STORED row's
      // `axisId` and owner.
      const introducesDocumentClaimingExecution = introducesUntrustedLeaseDocument(
        storedRow,
        normalized as unknown as LeasePipelineRow,
      );
      const untrustedDocument =
        introducesDocumentClaimingExecution &&
        !(await leaseBodyMatchesManagerFiledLease(
          ctx.db,
          storedRow?.axisId,
          existingRecord?.manager_user_id,
          {
            // The signable mode hides auxiliary HTML from leaseDocumentBody.
            // An external PDF filing is PDF-only, including its stored row.
            html: typeof normalized.generatedHtml === "string" ? normalized.generatedHtml : null,
            pdf: leaseDocumentBody(normalized as unknown as LeasePipelineRow).pdf,
          },
        ));

      // The signature itself, same reasoning as the document-body rule above.
      // `residentSignLease` / `managerSignLease` already refuse a second signature and a row
      // that was never sent, but they run in the browser against a store the browser owns —
      // and `row_data` is writable by the row's own resident, so that check was advisory.
      // Without this, a resident could sign twice (destroying the hash the first signature
      // recorded, which is the only evidence of what they agreed to) or sign a lease still
      // sitting in manager review. Keyed on the signature rather than the actor: writing
      // someone else's signature is the same forgery whoever's session it arrives on.
      //
      // Exempt: the corroborated filing of an already-executed OFF-PLATFORM lease, which is
      // not signing at all. Its trust comes from the bytes matching the lease the manager
      // filed on the application — the check immediately above — so it legitimately arrives
      // carrying both signatures on a row that was never "awaiting" either. The exemption is
      // keyed on that corroboration actually having run and passed, never on a request flag,
      // and it does not cover a write that adds signatures WITHOUT introducing the document
      // they attest to: that is the sign-before-send shape this guard exists to refuse.
      const filesCorroboratedExternalLease = introducesDocumentClaimingExecution && !untrustedDocument;
      if (
        storedRow &&
        normalized.externallySignedLease === true &&
        storedRow.externallySignedLease !== true &&
        (!filesCorroboratedExternalLease || !leaseClaimsExecution(normalized as LeasePipelineRow))
      ) {
        return NextResponse.json(
          { error: "An off-platform signed lease must use the verified signed-PDF filing." },
          { status: 409 },
        );
      }
      if (storedRow && !filesCorroboratedExternalLease) {
        const signatureRefusal = leaseSignatureWriteRefusal(
          storedRow,
          normalized as unknown as LeasePipelineRow,
        );
        if (signatureRefusal) {
          return NextResponse.json({ error: signatureRefusal }, { status: 409 });
        }

        // Whose signature it is, which the refusal above deliberately does not judge. From the
        // row's own state a manager countersignature is legitimate — the lease IS awaiting one
        // — so nothing else stopped a RESIDENT from writing it and marking the lease fully
        // executed against a manager who never countersigned. A party may only ever add their
        // own signature.
        const forgedRole = leaseSignatureRoleForgedBy(
          storedRow,
          normalized as unknown as LeasePipelineRow,
          ctx.user.role === "resident" ? "resident" : "manager",
        );
        if (forgedRole) {
          return NextResponse.json(
            { error: `Only the ${forgedRole} can add the ${forgedRole}'s signature.` },
            { status: 403 },
          );
        }
      }

      // P4's signature check above is authoritative once signing begins. These two
      // companion checks close the earlier window: a document must not be replaced
      // after the lease left manager review, even before the first signature lands.
      let nextRow = normalized as unknown as LeasePipelineRow;
      const documentChanged = Boolean(storedRow && leaseDocumentBodyChanged(storedRow, nextRow));
      if (documentChanged && nextRow.templateImportReview) {
        nextRow = { ...nextRow, templatePlacementReview: null };
        normalized = nextRow as unknown as Record<string, unknown>;
      }
      if (
        documentChanged &&
        effectiveLeaseDocumentMode(nextRow) === "imported-converted" &&
        nextRow.uploadedLeaseParse
      ) {
        const priorReviewAt = storedRow?.uploadedLeaseParse?.review.confirmedAtIso ?? null;
        const currentReview = nextRow.uploadedLeaseParse.review;
        const explicitReview = Boolean(
          currentReview.status === "confirmed" &&
          currentReview.confirmedAtIso &&
          currentReview.confirmedAtIso !== priorReviewAt &&
          currentReview.confirmedConvertedHtmlSha256,
        );
        if (!explicitReview) {
          nextRow = {
            ...nextRow,
            uploadedLeaseParse: {
              ...nextRow.uploadedLeaseParse,
              review: {
                ...currentReview,
                status: "needs_review",
                confirmedAtIso: null,
                confirmedDocumentSha256: null,
                confirmedConvertedHtmlSha256: null,
                resolvedSourceIssueCodes: [],
              },
            },
          };
          normalized = nextRow as unknown as Record<string, unknown>;
        }
      }

      // A sent imported lease needs a server-checked review of the exact source
      // and, for converted mode, the exact sanitized HTML offered for signature.
      // The browser gate is a convenience; row_data arrives from the client.
      const sendingToResident = ctx.user.role !== "resident" && nextRow.status === "Resident Signature Pending";
      const hasUploadedSource = Boolean(nextRow.managerUploadedPdf?.dataUrl);
      // Both uploaded lease PDFs and converted reusable templates use the
      // "imported-converted" document mode. The stored template provenance is
      // authoritative: a reusable placement has a server-owned import review
      // and private template URL, but no uploaded lease bytes or parse. Do not
      // route that case through the uploaded-source receipt gate below.
      const storedReusableTemplatePlacement = Boolean(
        storedRow?.templateImportReview &&
        storedRow.templateDocumentUrl &&
        !storedRow.managerUploadedPdf?.dataUrl &&
        !storedRow.uploadedLeaseParse,
      );
      const needsUploadedReview = sendingToResident && !storedReusableTemplatePlacement && Boolean(
        storedRow?.uploadedLeaseParse || storedRow?.uploadedLeaseReviewReceipt ||
        (storedRow?.documentMode === "imported-converted" && !storedRow.templateImportReview) ||
        (hasUploadedSource && (effectiveLeaseDocumentMode(nextRow) === "imported-converted" || nextRow.uploadedLeaseParse))
      );
      if (needsUploadedReview) {
        const parse = nextRow.uploadedLeaseParse;
        const receipt = storedRow?.uploadedLeaseReviewReceipt;
        const sourceSha256 = pdfDataUrlSha256(
          nextRow.managerUploadedPdf?.originalDataUrl ?? nextRow.managerUploadedPdf?.dataUrl,
        );
        const confirmedByAuthorizedManager = Boolean(
          receipt &&
          UUID_RE.test(receipt.confirmedByUserId) &&
          existingRecord &&
          await managerCanAccessLeaseRecord(ctx.db, receipt.confirmedByUserId, existingRecord, "edit"),
        );
        const expectedConvertedSha256 = effectiveLeaseDocumentMode(nextRow) === "imported-converted" && nextRow.generatedHtml
          ? sha256Hex(sanitizeLeaseDocumentHtml(nextRow.generatedHtml) ?? "")
          : null;
        const recordFingerprint = leaseRecordFingerprint({
          residentName: nextRow.residentName,
          leaseStart: nextRow.application?.leaseStart ?? null,
          leaseEnd: nextRow.application?.leaseEnd ?? null,
          rentLabel: nextRow.signedRentLabel ?? null,
        });
        if (
          !parse ||
          uploadedLeaseNeedsManagerConfirmation(parse) ||
          !receipt ||
          !confirmedByAuthorizedManager ||
          !sourceSha256 ||
          receipt.sourceSha256 !== sourceSha256 ||
          receipt.documentSha256 !== sourceSha256 ||
          receipt.convertedHtmlSha256 !== expectedConvertedSha256 ||
          parse.review.confirmedDocumentSha256 !== sourceSha256 ||
          parse.review.confirmedConvertedHtmlSha256 !== expectedConvertedSha256 ||
          parse.review.confirmedByUserId !== receipt.confirmedByUserId ||
          parse.review.confirmedRecordFingerprint !== recordFingerprint ||
          !Array.isArray(receipt.resolvedSourceIssueCodes) ||
          receipt.resolvedSourceIssueCodes.some((code) => !parse.review.resolvedSourceIssueCodes?.includes(code))
        ) {
          return NextResponse.json({ error: "Review the imported lease before sending it for signature." }, { status: 409 });
        }
        if (!parse.sourceSha256 || sourceSha256 !== parse.sourceSha256) {
          return NextResponse.json({ error: "The imported reading does not match the original PDF." }, { status: 409 });
        }
        if (effectiveLeaseDocumentMode(nextRow) === "imported-converted") {
          if (!nextRow.generatedHtml || uploadedLeaseConversionBlocker(parse, parse.review.resolvedSourceIssueCodes ?? [])) {
            return NextResponse.json({ error: "The converted lease has unresolved source pages." }, { status: 409 });
          }
        }
      }
      if (
        ctx.user.role !== "resident" &&
        nextRow.status === "Resident Signature Pending" &&
        Boolean(storedRow?.templateImportReview || nextRow.templateImportReview || nextRow.documentMode === "imported-converted" && nextRow.templateDocumentUrl)
      ) {
        if (!storedRow?.templateImportReview || nextRow.documentMode !== "imported-converted" || !nextRow.templateImportReview) {
          return NextResponse.json({ error: "The imported lease template review is missing or the selected signable version changed." }, { status: 409 });
        }
        if (
          nextRow.templateImportReview.sourceSha256 !== storedRow.templateImportReview.sourceSha256 ||
          nextRow.templateImportReview.convertedHtmlSha256 !== storedRow.templateImportReview.convertedHtmlSha256 ||
          nextRow.templateImportReview.templateVersion !== storedRow.templateImportReview.templateVersion ||
          nextRow.templateDocumentUrl !== storedRow.templateDocumentUrl
        ) return NextResponse.json({ error: "The imported lease template changed. Review the current version before sending." }, { status: 409 });
        const receipt = storedRow?.templatePlacementReview;
        const source = await verifyLeaseTemplateSource(ctx.db, storedRow.templateDocumentUrl, existingRecord?.manager_user_id ?? "");
        const reviewerAuthorized = Boolean(
          receipt &&
          UUID_RE.test(receipt.confirmedByUserId) &&
          existingRecord &&
          await managerCanAccessLeaseRecord(ctx.db, receipt.confirmedByUserId, existingRecord, "edit"),
        );
        if (
          !receipt ||
          !reviewerAuthorized ||
          !source ||
          source.path !== receipt.sourcePath ||
          source.sha256 !== receipt.sourceSha256 ||
          source.sha256 !== nextRow.templateImportReview.sourceSha256 ||
          receipt.templateVersion !== nextRow.templateImportReview.templateVersion ||
          !receipt.riderConflictAcknowledged ||
          receipt.finalHtmlSha256 !== sha256Hex(sanitizeLeaseDocumentHtml(nextRow.generatedHtml ?? "") ?? "")
        ) {
          return NextResponse.json({ error: "Review the original template and final placement lease before sending it for signature." }, { status: 409 });
        }
        nextRow = { ...nextRow, templatePlacementReview: receipt };
        normalized = nextRow as unknown as Record<string, unknown>;
      }

      // PRP-385: a Draft stub that clears signatures + body must NEVER overwrite
      // an executed lease. Renew/void set pendingRenewal, signedLeaseSnapshots, or Voided.
      if (
        storedRow &&
        ctx.user.role !== "resident" &&
        wipesExecutedLeaseWithoutSupersedeIntent(storedRow, nextRow)
      ) {
        return NextResponse.json(
          {
            error:
              "This lease is executed; its document and signatures cannot be cleared by a routine save. Use renew or void.",
          },
          { status: 409 },
        );
      }

      // A resident may legitimately replace a body (uploading their own signed PDF, seeding
      // the onboarding lease), so the refusal is scoped to the MANAGER's editing window
      // rather than to residents generally: while the lease sits in manager review, the
      // document is the manager's to change and nobody else's. Outside that window
      // `untrustedDocument` is what judges the resident's write.
      if (storedRow && documentChanged && ctx.user.role === "resident" && leaseAllowsManagerDocumentEdits(storedRow)) {
        return NextResponse.json({ error: "Only a manager can replace a lease document." }, { status: 403 });
      }

      // Scoped to non-resident actors on purpose: this is the "a manager cannot replace the
      // document after sending it" rule. A resident's body writes are judged by the 403 above
      // (never during the manager's window) and by `untrustedDocument` (never together with an
      // execution claim), and applying this rule to them too would refuse `residentUploadLeasePdf`.
      if (storedRow && documentChanged && ctx.user.role !== "resident" && !leaseAllowsManagerDocumentEdits(storedRow)) {
        const clearingSignatures = rowHasAnySignature(storedRow) && !rowHasAnySignature(nextRow);
        const previousBody = leaseDocumentBody(storedRow);
        // Filling a previously ABSENT body is not replacing one. The stored `externallySignedLease`
        // flag is one way to reach it; the other is a write the corroboration above already
        // vouched for, which is how the existing-resident onboarding seed arrives — that flag
        // rides on the INCOMING row, and this route never lets a request vouch for itself.
        const fillingAbsentBody = !previousBody.html && !previousBody.pdf;
        const filingExternalBody = fillingAbsentBody && (storedRow.externallySignedLease || !untrustedDocument);
        if (!clearingSignatures && !filingExternalBody) {
          return NextResponse.json(
            { error: "This lease is no longer in manager review; its document cannot be replaced." },
            { status: 409 },
          );
        }
      }

      // Manager save-path invariant, hence non-resident only: `residentUploadLeasePdf` nulls
      // `generatedHtml` by design, and the resident's own rules already judged that write.
      if (
        ctx.user.role !== "resident" &&
        storedGeneratedHtml &&
        typeof nextRow.generatedHtml !== "string" &&
        !incomingClearsSignatures
      ) {
        // `sendLeaseToResident` materializes a manager template into the first
        // `managerUploadedPdf` and clears `generatedHtml`. The template URL may
        // live only on the incoming row (resolved at send time) or the stored
        // row may have HTML without a persisted template pointer — both are
        // legitimate send paths and must not be refused as body deletion.
        const materializingTemplatePdf = Boolean(
          nextRow.managerUploadedPdf?.dataUrl &&
          !storedRow?.managerUploadedPdf?.dataUrl &&
          (storedRow?.templateDocumentUrl ||
            nextRow.templateDocumentUrl ||
            (typeof storedGeneratedHtml === "string" && storedGeneratedHtml.trim().length > 0)),
        );
        if (!materializingTemplatePdf) {
          return NextResponse.json({ error: "A generated lease body cannot be removed through this save path." }, { status: 400 });
        }
      }

      // A client may submit this generic row endpoint directly, so a generated
      // body replacement must still carry the same exact version increment the
      // dedicated edit path performs. The route stamps the server-confirmed
      // generation time rather than trusting a browser-provided timestamp.
      if (
        storedRow &&
        documentChanged &&
        ctx.user.role !== "resident" &&
        !incomingClearsSignatures &&
        typeof storedRow.generatedHtml === "string" &&
        typeof nextRow.generatedHtml === "string"
      ) {
        const expectedVersion = (storedRow.versionNumber ?? storedRow.pdfVersion ?? 1) + 1;
        if (nextRow.versionNumber !== expectedVersion || nextRow.pdfVersion !== expectedVersion) {
          return NextResponse.json({ error: "Replacing a generated lease requires the next document version." }, { status: 400 });
        }
        const editedAtIso = new Date().toISOString();
        normalized = {
          ...normalized,
          generatedAtIso: editedAtIso,
          // This public route cannot trust a browser-provided "generation"
          // marker. Every in-place generated HTML replacement is conservatively
          // treated as a manager edit, so automatic regeneration never erases it.
          managerDocumentEditedAtIso: editedAtIso,
          managerDocumentRegenerationRequiredAtIso: null,
        };
      }

      let scope: LeaseScopeColumns;
      if (ctx.user.role === "admin") {
        // Admin may re-point scope, but an omitted field still falls back to
        // the stored column. Admin GET returns the whole table, and an admin
        // previewing a manager portal drives the same browser store that posts
        // `action: "replace"`, so rebuilding scope from those rows could blank
        // `manager_user_id` AND `property_id` at once — the only two columns
        // `fetchLeasesForManagerUser` matches on, making the lease invisible to
        // the manager who owns it.
        scope = { ...storedScopeColumns(existingRecord), ...clientNamedScopeParts(normalized) };
      } else if (recordExists) {
        if (ctx.user.role === "resident") {
          const residentScope = residentIdentityFilter(ctx.user);
          if (!residentScope) return NextResponse.json({ error: "Record not found." }, { status: 404 });
          const { data: visible } = await ctx.db
            .from("portal_lease_pipeline_records")
            .select("id")
            .eq("id", id)
            .or(residentScope)
            .limit(1);
          if (!Array.isArray(visible) || visible.length === 0) {
            return NextResponse.json({ error: "Record not found." }, { status: 404 });
          }
          // A resident signs a lease; they never author one. Auto-file renders
          // the row's document into the PROPERTY OWNER's library, and
          // tenant-supplied bytes are untrusted, so a resident-scoped actor must
          // not be able to supply the body and the execution claim in the same
          // write — the state in which `replacesSignedLeaseDocument` above
          // cannot see a replacement. Auto-file declines on the SAME decision.
          if (untrustedDocument) {
            return NextResponse.json(
              { error: "A lease document cannot be replaced and signed in the same request." },
              { status: 409 },
            );
          }
          // The signature rules themselves ran earlier, for EVERY actor
          // (`leaseSignatureWriteRefusal` + `leaseSignatureRoleForgedBy`). A second
          // resident-only copy here would be a second source of truth for one rule, and the
          // narrower of the two: it never judged who the signature belongs to, so it could
          // not catch a resident writing the manager's countersignature.
          scope = storedScopeColumns(existingRecord);
        } else {
          const allowed = existingRecord
            ? await managerCanAccessLeaseRecord(ctx.db, ctx.user.id, existingRecord, "edit")
            : false;
          if (!allowed) return NextResponse.json({ error: "Record not found." }, { status: 404 });
          // A manager may RE-POINT scope, never blank it by omission. Every
          // field the client row does not name falls back to the column the
          // server already stored: clearing `property_id` would drop the lease
          // out of every co-manager's linked-property view, and clearing
          // `resident_email` / `resident_user_id` would orphan the resident
          // from their own lease — the same failure `storedScopeColumns`
          // prevents on the resident branch.
          const candidate: LeaseScopeColumns = {
            ...storedScopeColumns(existingRecord),
            ...clientNamedScopeParts(normalized),
            // Preserve server-trusted ownership on update.
            manager_user_id: existingRecord?.manager_user_id ?? ctx.user.id,
          };
          const refusal = await refuseUnownedProperty(candidate.property_id, existingRecord?.property_id);
          if (refusal) return refusal;
          scope = candidate;
        }
      } else if (ctx.user.role === "resident") {
        scope = filedFirstWriteScope
          ? {
              manager_user_id: filedFirstWriteScope.managerUserId,
              resident_user_id: asUuidOrNull(ctx.user.id),
              resident_email: filedFirstWriteScope.residentEmail,
              property_id: filedFirstWriteScope.propertyId,
            }
          : ownResidentScope(ctx.user);
      } else {
        // Naming ANOTHER person as the resident is a manager capability. The
        // branch is otherwise merely "not admin, not resident", which a vendor
        // — or an authenticated account with no profile row and no roles at
        // all — also satisfies, and `clientNamedScope` would then plant the row
        // in whatever resident scope the request asked for.
        const portalCtx = await getPortalAccessContext();
        if (!hasRole(portalCtx, "manager")) {
          return NextResponse.json(
            { error: "Only a property manager can create a lease record." },
            { status: 403 },
          );
        }
        const named = filedFirstWriteScope
          ? {
              ...clientNamedScope(normalized),
              resident_user_id: null,
              resident_email: filedFirstWriteScope.residentEmail,
              property_id: filedFirstWriteScope.propertyId,
            }
          : clientNamedScope(normalized);
        const refusal = await refuseUnownedProperty(named.property_id, null);
        if (refusal) return refusal;
        scope = { ...named, manager_user_id: ctx.user.id };
      }

      if (
        existingRecord && storedRow &&
        (
          leaseClaimsExecution(storedRow) || storedRow.status === "Fully Signed" || storedRow.externallySignedLease === true ||
          leaseClaimsExecution(normalized as LeasePipelineRow) || normalized.status === "Fully Signed" || normalized.externallySignedLease === true
        )
      ) {
        const signedScope = storedScopeColumns(existingRecord);
        if (
          scope.manager_user_id !== signedScope.manager_user_id ||
          scope.resident_user_id !== signedScope.resident_user_id ||
          scope.resident_email !== signedScope.resident_email ||
          scope.property_id !== signedScope.property_id
        ) {
          return NextResponse.json({ error: "A signed lease cannot be moved to another resident or property." }, { status: 409 });
        }
        scope = signedScope;
      }

      // Keyed by id, last wins: `previouslySigned` is read from the pre-batch
      // SELECT, so a repeated id would capture `false` twice and auto-file the
      // same lease into the library twice.
      planned.set(id, {
        row: normalized,
        record: buildUpsert(normalized, scope, existingRecord?.row_data),
        previouslySigned: Boolean(
          (existingRecord?.row_data as { fullySignedAt?: unknown } | undefined)?.fullySignedAt,
        ),
        untrustedDocument,
        previousRow: storedRow ?? null,
        expectedUpdatedAt: existingRecord?.updated_at ?? null,
      });
    }

    for (const plan of planned.values()) {
      const managerUserId = plan.record.manager_user_id;
      let notificationSender = { userId: ctx.user.id, email: ctx.user.email ?? "", name: ctx.user.name ?? undefined };
      if (managerUserId && managerUserId !== ctx.user.id && leaseEventForTransition(plan.previousRow, plan.record.row_data as LeasePipelineRow)) {
        const { data: managerProfile, error: managerProfileError } = await ctx.db
          .from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
        if (managerProfileError || !managerProfile?.email) {
          return NextResponse.json({ error: "Could not resolve the lease notification sender." }, { status: 500 });
        }
        notificationSender = {
          userId: managerUserId,
          email: String(managerProfile.email).trim().toLowerCase(),
          name: String(managerProfile.full_name ?? "").trim() || undefined,
        };
      }
      const transition = managerUserId ? buildDurableLeaseTransitionEnvelope({
        automated: await loadAutomatedMessageSettings(ctx.db, managerUserId).catch(() => null),
        managerUserId,
        previous: plan.previousRow,
        lease: plan.record.row_data as LeasePipelineRow,
        actor: notificationSender,
        triggeringActorUserId: ctx.user.id,
      }) : null;
      const { data: persistence, error } = await ctx.db.rpc("persist_lease_with_action_event", {
        p_record: plan.record,
        p_expected_updated_at: plan.expectedUpdatedAt,
        p_event: transition,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (persistence !== "persisted") return NextResponse.json({ error: "The lease changed in another session. Refresh and try again." }, { status: 409 });

      // Auto-file the signed lease into the document library on the transition
      // into fully-signed (once), so repeated syncs of the same row don't
      // duplicate. No-op unless the manager opted the "lease" category in, and
      // never for a body the server did not already hold — the same decision the
      // resident guard above refuses on, so the two cannot disagree.
      const nowSigned = Boolean((plan.row as { fullySignedAt?: unknown }).fullySignedAt);
      if (nowSigned && !plan.previouslySigned && !plan.untrustedDocument) {
        await autoFileLeaseDocument(ctx.db, plan.record.row_data as AutoFileLeaseRow).catch(() => undefined);
      }

      if (managerUserId) {
        void syncLeaseLifecycleTasks(
          ctx.db,
          managerUserId,
          plan.previousRow,
          plan.row as LeasePipelineRow,
        ).catch(() => undefined);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
