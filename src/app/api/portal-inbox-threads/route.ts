import { NextResponse } from "next/server";
import { viewerAndLinkedOwnerIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { buildPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import {
  ADMIN_INBOX_SCOPE,
  applyPortalInboxThreadScope,
  MANAGER_INBOX_SCOPE,
  RESIDENT_INBOX_SCOPE,
  resolveInboxScopeUser,
} from "@/lib/portal-inbox-thread-scope";
import { ensureManagerAgentNoticeThread } from "@/lib/agent-notify.server";
import { ensureResidentAgentThread } from "@/lib/agent/resident-inbox-agent.server";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import {
  collapseAssistantInboxThreads,
  collapsePersonInboxThreads,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

export const runtime = "nodejs";

function normalizeInboxRow(row: Record<string, unknown>): PersistedInboxThread {
  return {
    ...row,
    id: String(row.id ?? "").trim(),
    email: String(row.email ?? row.participantEmail ?? row.participant_email ?? "").trim().toLowerCase(),
  } as PersistedInboxThread;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scopeParam = url.searchParams.get("scope") ?? "";
    const ctx = await resolveInboxScopeUser(scopeParam);
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    // Make sure a resident always has their assistant conversation before the
    // list is read, so it simply appears in Communication with no extra call
    // from the client. Deterministic id keeps this idempotent; a failure here
    // must never take down the inbox, so it is swallowed.
    if (scopeParam === RESIDENT_INBOX_SCOPE && ctx.user.id && ctx.user.email) {
      try {
        const managerIds = await managerIdsOwningResident(ctx.db, ctx.user.email);
        // Bound to ONE manager when known — the first that owns this resident.
        await ensureResidentAgentThread(ctx.db, {
          residentUserId: ctx.user.id,
          residentEmail: ctx.user.email,
          managerUserId: managerIds[0],
        });
      } catch (e) {
        console.error("ensureResidentAgentThread failed", e);
      }
    }

    if (scopeParam === MANAGER_INBOX_SCOPE && ctx.user.id) {
      try {
        await ensureManagerAgentNoticeThread(ctx.db, ctx.user.id);
      } catch (e) {
        console.error("ensureManagerAgentNoticeThread failed", e);
      }
    }

    let query = ctx.db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (scopeParam === ADMIN_INBOX_SCOPE && ctx.user.role === "admin") {
      query = query.eq("scope", ADMIN_INBOX_SCOPE) as typeof query;
    } else {
      const extraOwnerIds =
        scopeParam === MANAGER_INBOX_SCOPE
          ? await viewerAndLinkedOwnerIdsForModule(ctx.db, ctx.user.id, "inbox", "read")
          : [];
      query = applyPortalInboxThreadScope(query, ctx.user, extraOwnerIds) as typeof query;
      if (scopeParam) {
        query = query.eq("scope", scopeParam) as typeof query;
      }
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const records = (Array.isArray(data) ? data : []) as { id: string; row_data: unknown; updated_at: string }[];
    const rows = records.map((record) => {
      const row = (record.row_data && typeof record.row_data === "object" ? record.row_data : record) as Record<string, unknown>;
      return normalizeInboxRow(row);
    });

    const collapsed =
      scopeParam === MANAGER_INBOX_SCOPE
        ? collapsePersonInboxThreads(rows, { mergeFolders: true })
        : scopeParam === RESIDENT_INBOX_SCOPE
          ? collapseAssistantInboxThreads(rows)
          : rows;

    return NextResponse.json({
      rows:
        scopeParam === MANAGER_INBOX_SCOPE
          ? collapseAssistantInboxThreads(collapsed)
          : collapsed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "deleteIds" | "replace";
      id?: string;
      ids?: unknown[];
      row?: Record<string, unknown>;
      rows?: Record<string, unknown>[];
    };

    const scopeKey = String(
      body.action === "replace"
        ? (body.rows?.[0]?.scope ?? "")
        : body.action === "upsert"
          ? (body.row?.scope ?? "")
          : "",
    ).trim();

    const ctx = await resolveInboxScopeUser(scopeKey);
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    if (body.action === "delete" || body.action === "deleteIds") {
      const ids =
        body.action === "deleteIds"
          ? (Array.isArray(body.ids) ? body.ids.map(String) : [])
          : [body.id?.trim() ?? ""];
      if (ids.length === 0 || ids.some((id) => !id)) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      const extraOwnerIds =
        scopeKey === MANAGER_INBOX_SCOPE
          ? await viewerAndLinkedOwnerIdsForModule(ctx.db, ctx.user.id, "inbox", "delete")
          : [];
      let deleted = 0;
      for (const id of ids) {
        let deleteQuery = ctx.db.from("portal_inbox_thread_records").delete().eq("id", id).select("id");
        deleteQuery = applyPortalInboxThreadScope(deleteQuery, ctx.user, extraOwnerIds) as typeof deleteQuery;
        const { data, error } = await deleteQuery;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        deleted += Array.isArray(data) ? data.length : 0;
      }
      return NextResponse.json({ ok: true, deleted });
    }

    const rows = body.action === "replace" ? body.rows ?? [] : body.row ? [body.row] : [];
    if (rows.length === 0) return NextResponse.json({ error: "row required" }, { status: 400 });

    for (const row of rows) {
      const normalized = normalizeInboxRow(row);
      const record = buildPortalInboxThreadUpsert(normalized, ctx.user);
      if (!record.id) return NextResponse.json({ error: "row id required" }, { status: 400 });
      const id = String(record.id);

      const { data: existing, error: existingError } = await ctx.db
        .from("portal_inbox_thread_records")
        .select("id, owner_user_id, participant_email, scope")
        .eq("id", id)
        .limit(1);
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

      const recordExists = Array.isArray(existing) && existing.length > 0;
      if (recordExists) {
        const extraOwnerIds =
          scopeKey === MANAGER_INBOX_SCOPE
            ? await viewerAndLinkedOwnerIdsForModule(ctx.db, ctx.user.id, "inbox", "edit")
            : [];
        let visibleQuery = ctx.db.from("portal_inbox_thread_records").select("id").eq("id", id).limit(1);
        visibleQuery = applyPortalInboxThreadScope(visibleQuery, ctx.user, extraOwnerIds) as typeof visibleQuery;
        const { data: visible, error: visibleError } = await visibleQuery;
        if (visibleError) return NextResponse.json({ error: visibleError.message }, { status: 500 });
        if (!Array.isArray(visible) || visible.length === 0) {
          return NextResponse.json({ error: "Record not found." }, { status: 404 });
        }

        const prior = existing[0] as {
          owner_user_id?: string | null;
          participant_email?: string | null;
          scope?: string | null;
        };
        record.owner_user_id = prior.owner_user_id ?? record.owner_user_id;
        record.participant_email = record.participant_email ?? prior.participant_email ?? null;
        record.scope = prior.scope ?? record.scope;
      } else if (ctx.user.role !== "admin") {
        record.owner_user_id = ctx.user.id;
      }

      const { error } = await ctx.db.from("portal_inbox_thread_records").upsert(record, { onConflict: "id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
