import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type RecordUser = { id: string; email?: string | null; role: string };

type RecordConfig = {
  table: string;
  select?: string;
  orderColumn?: string;
  normalize?: (row: Record<string, unknown>) => Record<string, unknown>;
  scope?: (query: unknown, user: RecordUser) => unknown;
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
  /** Reconcile an upsert with server-stored state before it is persisted. */
  reconcileExisting?: (
    record: Record<string, unknown>,
    user: RecordUser,
    existing: Record<string, unknown> | null,
  ) => Record<string, unknown>;
};

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export function createJsonRecordRoute(config: RecordConfig) {
  async function getUserContext() {
    const user = await sessionUser();
    if (!user) return null;
    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const admin = await isAdminUser(user.id);
    return {
      db,
      user: {
        id: user.id,
        email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
        role: admin ? "admin" : String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase(),
      },
    };
  }

  return {
    GET: async () => {
      try {
        const ctx = await getUserContext();
        if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
        let query = ctx.db
          .from(config.table)
          .select(config.select ?? "id, row_data, updated_at")
          .order(config.orderColumn ?? "updated_at", { ascending: false })
          .limit(500);
        if (config.scope) query = config.scope(query, ctx.user) as typeof query;
        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        const records = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
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
        };
        if (body.action === "delete" || body.action === "deleteIds") {
          const ids = body.action === "deleteIds"
            ? (Array.isArray((body as { ids?: unknown }).ids) ? (body as { ids: unknown[] }).ids.map(String) : [])
            : [body.id?.trim() ?? ""];
          if (ids.length === 0 || ids.some((id) => !id)) return NextResponse.json({ error: "id required" }, { status: 400 });
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
        if (rows.length === 0) return NextResponse.json({ error: "row required" }, { status: 400 });
        for (const row of rows) {
          const normalized = config.normalize ? config.normalize(row) : row;
          const record = config.buildUpsert(normalized, ctx.user);
          if (!record.id) return NextResponse.json({ error: "row id required" }, { status: 400 });
          const id = String(record.id);
          const { data: existing, error: existingError } = await ctx.db
            .from(config.table)
            .select("id, manager_user_id, row_data")
            .eq("id", id)
            .limit(1);
          if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
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
          const finalRecord = config.reconcileExisting
            ? config.reconcileExisting(
                ownedRecord,
                ctx.user,
                recordExists ? ((existing?.[0] as Record<string, unknown>) ?? null) : null,
              )
            : ownedRecord;
          if (!recordExists && config.assertInsertAllowed) {
            const insertError = config.assertInsertAllowed(finalRecord, ctx.user);
            if (insertError) return NextResponse.json({ error: insertError }, { status: 403 });
          }
          const { error } = await ctx.db.from(config.table).upsert(finalRecord, { onConflict: "id" });
          if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to save records.";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  };
}
