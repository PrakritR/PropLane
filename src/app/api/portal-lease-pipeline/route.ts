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
  leaseAllowsManagerDocumentEdits,
  leaseDocumentBody,
  leaseDocumentBodyChanged,
  leaseClaimsExecution,
  refuseResidentLeaseSignatureWrite,
  replacesSignedLeaseDocument,
  leaseSignatureRoleForgedBy,
  leaseSignatureWriteRefusal,
  rowHasAnySignature,
} from "@/lib/lease-execution-evidence";
import { leaseBodyMatchesManagerFiledLease } from "@/lib/lease-manager-filed-document.server";
import { sanitizeLeaseDocumentHtml, sanitizeManagerLeaseDocumentEdit } from "@/lib/lease-document-sanitizer";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { syncLeaseLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/** The resident-identity scope for this route's two reads; null = match nothing. */
function residentIdentityFilter(user: { id?: string | null; email?: string | null }): string | null {
  return orFilterForIdentity([
    ["resident_user_id", user.id],
    ["resident_email", user.email],
  ]);
}

export const runtime = "nodejs";

type RecordUser = { id: string; email?: string | null; role: string };

async function getUserContext() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
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
      role,
    } satisfies RecordUser,
  };
}

function normalizeRow(row: Record<string, unknown>, { sanitizeGeneratedHtml = false }: { sanitizeGeneratedHtml?: boolean } = {}) {
  const generatedHtml =
    sanitizeGeneratedHtml && typeof row.generatedHtml === "string" ? sanitizeLeaseDocumentHtml(row.generatedHtml) : row.generatedHtml;
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

export async function GET() {
  try {
    const ctx = await getUserContext();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

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

    const rows = records.map((record) => {
      const row = (record.row_data && typeof record.row_data === "object" ? record.row_data : record) as Record<
        string,
        unknown
      >;
      return normalizeRow(row);
    });

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
      action?: "upsert" | "delete" | "deleteIds" | "replace";
      id?: string;
      ids?: unknown[];
      row?: Record<string, unknown>;
      rows?: Record<string, unknown>[];
    };

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
      for (const id of ids) {
        const { data: existing } = await ctx.db
          .from("portal_lease_pipeline_records")
          .select("id, manager_user_id, property_id")
          .eq("id", id)
          .limit(1);
        const record = (existing ?? [])[0] as LeaseScopeRecord | undefined;
        if (!record) continue;
        if (ctx.user.role !== "admin") {
          const allowed = await managerCanAccessLeaseRecord(ctx.db, ctx.user.id, record, "delete");
          if (!allowed) continue;
        }
        await ctx.db.from("portal_lease_pipeline_records").delete().eq("id", id);
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
        .select("id, manager_user_id, resident_user_id, resident_email, property_id, row_data")
        .eq("id", id)
        .limit(1);
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

      const recordExists = Array.isArray(existing) && existing.length > 0;
      const existingRecord = (existing ?? [])[0] as
        | (LeaseScopeRecord & StoredLeaseScopeColumns & { row_data?: Record<string, unknown> })
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
      if (storedRow && replacesSignedLeaseDocument(storedRow, normalized as unknown as LeasePipelineRow)) {
        return NextResponse.json(
          { error: "This lease already carries a signature; its document cannot be replaced." },
          { status: 409 },
        );
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
          leaseDocumentBody(normalized as unknown as LeasePipelineRow),
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
      const nextRow = normalized as unknown as LeasePipelineRow;
      const documentChanged = Boolean(storedRow && leaseDocumentBodyChanged(storedRow, nextRow));

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
          if (storedRow) {
            const residentSigningExempt =
              !untrustedDocument && leaseClaimsExecution(nextRow) && !leaseClaimsExecution(storedRow);
            const signatureRefusal = refuseResidentLeaseSignatureWrite(storedRow, nextRow, {
              exemptNotReady: residentSigningExempt,
            });
            if (!signatureRefusal.ok) {
              return NextResponse.json({ error: signatureRefusal.error }, { status: signatureRefusal.status });
            }
          }
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
        scope = ownResidentScope(ctx.user);
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
        const named = clientNamedScope(normalized);
        const refusal = await refuseUnownedProperty(named.property_id, null);
        if (refusal) return refusal;
        scope = { ...named, manager_user_id: ctx.user.id };
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
      });
    }

    for (const plan of planned.values()) {
      const { error } = await ctx.db
        .from("portal_lease_pipeline_records")
        .upsert(plan.record, { onConflict: "id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Auto-file the signed lease into the document library on the transition
      // into fully-signed (once), so repeated syncs of the same row don't
      // duplicate. No-op unless the manager opted the "lease" category in, and
      // never for a body the server did not already hold — the same decision the
      // resident guard above refuses on, so the two cannot disagree.
      const nowSigned = Boolean((plan.row as { fullySignedAt?: unknown }).fullySignedAt);
      if (nowSigned && !plan.previouslySigned && !plan.untrustedDocument) {
        await autoFileLeaseDocument(ctx.db, plan.record.row_data as AutoFileLeaseRow).catch(() => undefined);
      }

      const managerUserId = plan.record.manager_user_id;
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
