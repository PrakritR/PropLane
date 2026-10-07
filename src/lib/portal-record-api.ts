import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { preserveStoredSmsTestProvenance } from "@/lib/sms/sms-test-provenance";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

type RecordUser = { id: string; email?: string | null; role: string; roles?: string[] };
type AtomicWriteResult = { handled: boolean; error?: string; status?: number };

type RecordConfig = {
  table: string;
  select?: string;
  orderColumn?: string;
  /**
   * Columns selected when checking whether an upsert target row already
   * exists, before deciding insert vs update. Every table has `id` and
   * `row_data`; add only additional columns THIS table's schema actually
   * has, that a hook below (`reconcileExisting` / `atomicWrite` /
   * `afterWrite`) reads off the `existing` row it receives. Defaults to
   * "id, row_data" — never add `manager_user_id` or any other ownership
   * column here unless the table's own migration actually created it; an
   * unconditional column that doesn't exist 500s the write for every
   * caller (how `portal_bug_feedback_records` broke: commit aee8c7a15a
   * added an unconditional `manager_user_id` here for every table, but
   * that table has only `reporter_user_id`).
   */
  existingRowSelect?: string;
  /**
   * Columns selected for each delete/deleteIds target before
   * `authorizeDelete` runs. Every table has `id` and `row_data`; add only
   * additional columns this table's schema actually has that
   * `authorizeDelete` reads. Defaults to "id, row_data".
   */
  deleteRowSelect?: string;
  normalize?: (row: Record<string, unknown>) => Record<string, unknown>;
  scope?: (query: unknown, user: RecordUser) => unknown;
  /** Optional server-side reader for tables with item-level authorization inside JSON containers. */
  readRecords?: (args: { db: ReturnType<typeof createSupabaseServiceRoleClient>; user: RecordUser }) => Promise<{
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
  }>;
  /** Project rows before they are serialized. It must remove unauthorized rows, not merely redact them. */
  projectRead?: (args: {
    db: ReturnType<typeof createSupabaseServiceRoleClient>;
    user: RecordUser;
    records: Record<string, unknown>[];
  }) => Promise<Record<string, unknown>[]>;
  /** Batch authorization for delete/deleteIds. Called after every target is read, before any delete. */
  authorizeDelete?: (args: {
    db: ReturnType<typeof createSupabaseServiceRoleClient>;
    user: RecordUser;
    records: Record<string, unknown>[];
  }) => Promise<{ ok: true } | { ok: false; error: string; status?: number }>;
  buildUpsert: (row: Record<string, unknown>, user: RecordUser) => Record<string, unknown>;
  /**
   * Stamps server-trusted ownership columns onto a record that is being created
   * (a new id). Used to ignore client-supplied owner ids on INSERT so a caller
   * cannot write rows under another tenant. Not applied to existing records,
   * whose writes are already gated by `scope`.
   */
  assignOwnership?: (record: Record<string, unknown>, user: RecordUser) => Record<string, unknown>;
  /** Reject INSERT when the record id is not owned by the caller (returns error message). */
  assertInsertAllowed?: (record: Record<string, unknown>, user: RecordUser) => string | null;
  /** Batch authorization before any existing-row reads or writes occur. */
  authorizeUpsert?: (args: {
    db: ReturnType<typeof createSupabaseServiceRoleClient>;
    user: RecordUser;
    records: Record<string, unknown>[];
  }) => Promise<{ ok: true } | { ok: false; error: string; status?: number }>;
  /** Reconcile an upsert with server-stored state before it is persisted. */
  reconcileExisting?: (
    record: Record<string, unknown>,
    user: RecordUser,
    existing: Record<string, unknown> | null,
  ) => Record<string, unknown>;
  /**
   * Best-effort side effect after a successful upsert (e.g. pushing an
   * availability record to Google Calendar). Runs AFTER the upsert, is never
   * awaited into a failure of the request — a save always succeeds locally
   * even if this throws — and receives the pre-upsert row so a caller can
   * diff against what was there before.
   */
  afterWrite?: (args: {
    record: Record<string, unknown>;
    user: RecordUser;
    existing: Record<string, unknown> | null;
    db: SupabaseClient;
  }) => void | Promise<void>;
  /** Optional table-specific transaction boundary for rows whose JSON payload
   * is shared by several managers. `handled` skips the ordinary upsert. */
  atomicWrite?: (args: {
    db: ReturnType<typeof createSupabaseServiceRoleClient>;
    user: RecordUser;
    record: Record<string, unknown>;
    existing: Record<string, unknown> | null;
    /** Client-observed payload used by a table-specific compare-and-swap. */
    expectedPayload: unknown;
    /** Whether the caller actually supplied an observed payload. */
    expectedPayloadKnown: boolean;
  }) => Promise<AtomicWriteResult>;
};

async function getUserContext() {
  const portalCtx = await getPortalAccessContext();
  if (!portalCtx.user) return null;
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(portalCtx.user.id, db)).kind === "denied") return null;
  const admin = await isAdminUser(portalCtx.user.id);
  const role = admin
    ? "admin"
    : String(
        portalCtx.effectiveRole ?? portalCtx.roles[0] ?? portalCtx.profile?.role ?? "",
      ).toLowerCase();
  return {
    db,
    user: {
      id: portalCtx.user.id,
      email: (portalCtx.profile?.email ?? portalCtx.user.email ?? "").trim().toLowerCase(),
      role,
      roles: portalCtx.roles,
    },
  };
}

export function createJsonRecordRoute(config: RecordConfig) {
  return {
    GET: async () => {
      try {
        const ctx = await getUserContext();
        if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
        let data: Record<string, unknown>[] | null;
        let error: { message: string } | null;
        if (config.readRecords) {
          ({ data, error } = await config.readRecords({ db: ctx.db, user: ctx.user }));
        } else {
          let query = ctx.db
            .from(config.table)
            .select(config.select ?? "id, row_data, updated_at")
            .order(config.orderColumn ?? "updated_at", { ascending: false })
            .limit(500);
          if (config.scope) query = config.scope(query, ctx.user) as typeof query;
          const result = await query;
          data = result.data as unknown as Record<string, unknown>[] | null;
          error = result.error ? { message: result.error.message } : null;
        }
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        let records = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
        if (config.projectRead) records = await config.projectRead({ db: ctx.db, user: ctx.user, records });
        const rows = records.map((record) => {
          const payload = (
            record.row_data && typeof record.row_data === "object" ? record.row_data : record
          ) as Record<string, unknown>;
          const merged = {
            ...payload,
            id: payload.id ?? record.id,
            reporter_user_id: payload.reporter_user_id ?? payload.reporterUserId ?? record.reporter_user_id,
            reporter_email: payload.reporter_email ?? payload.reporterEmail ?? record.reporter_email,
            reporter_role: payload.reporter_role ?? payload.reporterRole ?? record.reporter_role,
            report_type: payload.report_type ?? payload.type ?? record.report_type,
            created_at: payload.created_at ?? payload.createdAt ?? record.created_at,
            updated_at: payload.updated_at ?? payload.updatedAt ?? record.updated_at,
          };
          return config.normalize ? config.normalize(merged) : merged;
        });
        return NextResponse.json({ rows });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load records.";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
    POST: async (req: Request) => {
      try {
        const ctx = await getUserContext();
        if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
        const body = (await req.json()) as {
          action?: "upsert" | "delete" | "deleteIds" | "replace";
          id?: string;
          ids?: unknown[];
          row?: Record<string, unknown>;
          rows?: Record<string, unknown>[];
          expectedPayload?: unknown;
          expectedPayloadKnown?: boolean;
        };
        if (body.action === "delete" || body.action === "deleteIds") {
          const ids = body.action === "deleteIds"
            ? (Array.isArray((body as { ids?: unknown }).ids) ? (body as { ids: unknown[] }).ids.map(String) : [])
            : [body.id?.trim() ?? ""];
          if (ids.length === 0 || ids.some((id) => !id)) return NextResponse.json({ error: "id required" }, { status: 400 });
          const targets: Record<string, unknown>[] = [];
          for (const id of ids) {
            const { data, error } = await ctx.db
              .from(config.table)
              .select(config.deleteRowSelect ?? "id, row_data")
              .eq("id", id)
              .limit(1);
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            // A per-table, non-literal select string defeats supabase-js's
            // literal-select type inference, so this cast goes through
            // `unknown` first rather than directly to `Record<string, unknown>`.
            const deleteTargetRows = data as unknown as Record<string, unknown>[] | null;
            const target = Array.isArray(deleteTargetRows) ? deleteTargetRows[0] : undefined;
            if (!target) return NextResponse.json({ error: "Record not found." }, { status: 404 });
            targets.push(target);
          }
          if (config.authorizeDelete) {
            const authorization = await config.authorizeDelete({ db: ctx.db, user: ctx.user, records: targets });
            if (!authorization.ok) {
              return NextResponse.json({ error: authorization.error }, { status: authorization.status ?? 403 });
            }
          }
          for (const id of ids) {
            if (config.scope) {
              let visibleQuery = ctx.db.from(config.table).select("id").eq("id", id).limit(1);
              visibleQuery = config.scope(visibleQuery, ctx.user) as typeof visibleQuery;
              const { data: visible, error: visibleError } = await visibleQuery;
              if (visibleError) return NextResponse.json({ error: visibleError.message }, { status: 500 });
              if (!Array.isArray(visible) || visible.length === 0) {
                return NextResponse.json({ error: "Record not found." }, { status: 404 });
              }
            }
          }
          let deleted = 0;
          for (const id of ids) {
            let deleteQuery = ctx.db.from(config.table).delete().eq("id", id).select("id");
            if (config.scope) deleteQuery = config.scope(deleteQuery, ctx.user) as typeof deleteQuery;
            const { data, error } = await deleteQuery;
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            deleted += Array.isArray(data) ? data.length : 0;
          }
          if (deleted === 0) {
            return NextResponse.json({ error: "Record not found." }, { status: 404 });
          }
          return NextResponse.json({ ok: true, deleted });
        }

        const rows = body.action === "replace" ? body.rows ?? [] : body.row ? [body.row] : [];
        // "replace" only upserts the rows it is given (it never deletes absent
        // ones), so an empty replace is a no-op, not an error.
        if (rows.length === 0 && body.action === "replace") return NextResponse.json({ ok: true, upserted: 0 });
        if (rows.length === 0) return NextResponse.json({ error: "row required" }, { status: 400 });
        const records = rows.map((row) => {
          const normalized = config.normalize ? config.normalize(row) : row;
          return config.buildUpsert(normalized, ctx.user);
        });
        if (records.some((record) => !record.id)) return NextResponse.json({ error: "row id required" }, { status: 400 });
        if (config.authorizeUpsert) {
          const authorization = await config.authorizeUpsert({ db: ctx.db, user: ctx.user, records });
          if (!authorization.ok) {
            return NextResponse.json({ error: authorization.error }, { status: authorization.status ?? 403 });
          }
        }
        for (const record of records) {
          if (!record.id) return NextResponse.json({ error: "row id required" }, { status: 400 });
          const id = String(record.id);
          const { data: existingData, error: existingError } = await ctx.db
            .from(config.table)
            .select(config.existingRowSelect ?? "id, row_data")
            .eq("id", id)
            .limit(1);
          if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
          // Same non-literal-select type-inference workaround as the delete
          // path above.
          const existing = existingData as unknown as Record<string, unknown>[] | null;
          const recordExists = Array.isArray(existing) && existing.length > 0;
          if (recordExists && config.scope) {
            let visibleQuery = ctx.db.from(config.table).select("id").eq("id", id).limit(1);
            visibleQuery = config.scope(visibleQuery, ctx.user) as typeof visibleQuery;
            const { data: visible, error: visibleError } = await visibleQuery;
            if (visibleError) return NextResponse.json({ error: visibleError.message }, { status: 500 });
            if (!Array.isArray(visible) || visible.length === 0) {
              return NextResponse.json({ error: "Record not found." }, { status: 404 });
            }
          }
          // On INSERT, stamp server-trusted ownership so client-supplied owner
          // ids cannot be used to write rows under another tenant.
          const ownedRecord = !recordExists && config.assignOwnership ? config.assignOwnership(record, ctx.user) : record;
          let finalRecord = config.reconcileExisting
            ? config.reconcileExisting(
                ownedRecord,
                ctx.user,
                recordExists ? ((existing?.[0] as Record<string, unknown>) ?? null) : null,
              )
            : ownedRecord;
          if (finalRecord.row_data && typeof finalRecord.row_data === "object") {
            const storedRowData = (existing?.[0] as { row_data?: unknown } | undefined)?.row_data;
            finalRecord = {
              ...finalRecord,
              row_data: preserveStoredSmsTestProvenance(
                finalRecord.row_data as Record<string, unknown>,
                storedRowData,
              ),
            };
          }
          if (!recordExists && config.assertInsertAllowed) {
            const insertError = config.assertInsertAllowed(finalRecord, ctx.user);
            if (insertError) return NextResponse.json({ error: insertError }, { status: 403 });
          }
          if (config.atomicWrite) {
            const atomic = await config.atomicWrite({
              db: ctx.db,
              user: ctx.user,
              record: finalRecord,
              existing: recordExists ? ((existing?.[0] as Record<string, unknown>) ?? null) : null,
              expectedPayload: body.expectedPayload,
              expectedPayloadKnown:
                body.expectedPayloadKnown === true ||
                (body.expectedPayloadKnown === undefined &&
                  Object.prototype.hasOwnProperty.call(body, "expectedPayload")),
            });
            if (atomic.handled) {
              if (atomic.error) return NextResponse.json({ error: atomic.error }, { status: atomic.status ?? 500 });
              continue;
            }
          }
          const { error } = await ctx.db.from(config.table).upsert(finalRecord, { onConflict: "id" });
          if (error) {
            // A table trigger's refusal (last bed taken, invalid dates) is the caller's
            // conflict, not a server failure — same mapping as the applications route.
            const code = String((error as { code?: unknown }).code ?? "");
            const status = ["P4001", "40001", "40P01"].includes(code) ? 409 : code === "23514" ? 422 : 500;
            return NextResponse.json({ error: error.message }, { status });
          }
          if (config.afterWrite) {
            try {
              await config.afterWrite({
                record: finalRecord,
                user: ctx.user,
                existing: recordExists ? ((existing?.[0] as Record<string, unknown>) ?? null) : null,
                db: ctx.db,
              });
            } catch (e) {
              console.warn(`[portal-record-api] afterWrite hook failed for ${config.table}/${id}`, e);
            }
          }
        }
        return NextResponse.json({ ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to save records.";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  };
}
