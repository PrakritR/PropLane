import { smsNoticeMembers, storedSmsNoticeIdentity, updateSmsNoticeMailboxState } from "@/lib/sms-inbox-state.server";
import { createHash } from "node:crypto";
import { visibleManagerSmsProjectionIds } from "@/lib/sms/sms-projection-inbox.server";
import type { SmsProjectionSummary } from "@/lib/sms/sms-projection.server";
import { portalInboxReadObservation, type PortalInboxReadRecord } from "@/lib/portal-inbox-read-state.server";
import { NextResponse } from "next/server";
import {
  filterVisibleInboxThreadRecords,
  resolveCommunicationScope,
  type CommunicationScope,
} from "@/lib/communication/conversation-visibility.server";
import { buildPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import {
  ADMIN_INBOX_SCOPE,
  applyPortalInboxThreadScope,
  MANAGER_INBOX_SCOPE,
  RESIDENT_INBOX_SCOPE,
  resolveInboxScopeUser,
} from "@/lib/portal-inbox-thread-scope";
import { ensureManagerAgentNoticeThread } from "@/lib/agent-notify.server";
import { isTeamThreadId, updateTeamThreadMailboxState } from "@/lib/team-comms.server";
import { ensureResidentAgentThread } from "@/lib/agent/resident-inbox-agent.server";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import {
  collapseAssistantInboxThreads,
  collapsePersonInboxThreads,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

export const runtime = "nodejs";

function normalizeInboxRow(row: Record<string, unknown>): PersistedInboxThread {
  const {
    readSources: _readSources,
    readSourcesComplete: _readSourcesComplete,
    smsBindingKeys: _smsBindingKeys,
    ...stored
  } = row;
  return {
    ...stored,
    id: String(stored.id ?? "").trim(),
    email: String(stored.email ?? stored.participantEmail ?? stored.participant_email ?? "").trim().toLowerCase(),
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
        const { resolveActiveWorkspaceFromRequest } = await import("@/lib/workspaces/active.server");
        const active = await resolveActiveWorkspaceFromRequest(ctx.db, ctx.user.id);
        await ensureManagerAgentNoticeThread(ctx.db, ctx.user.id, {
          id: active.id,
          isDefault: active.isDefault,
        });
      } catch (e) {
        console.error("ensureManagerAgentNoticeThread failed", e);
      }
    }

    let query = ctx.db
      .from("portal_inbox_thread_records")
      .select("id, scope, row_data, updated_at, owner_user_id, participant_email, thread_type")
      .order("updated_at", { ascending: false })
      .limit(500);

    // Manager Communication is decided per house and per workspace by ONE
    // resolver; the store query only pre-narrows to owners it names.
    let communicationScope: CommunicationScope | null = null;
    if (scopeParam === ADMIN_INBOX_SCOPE && ctx.user.role === "admin") {
      query = query.eq("scope", ADMIN_INBOX_SCOPE) as typeof query;
    } else {
      if (scopeParam === MANAGER_INBOX_SCOPE) {
        communicationScope = await resolveCommunicationScope(ctx.db, ctx.user.id, "read");
      }
      query = applyPortalInboxThreadScope(query, ctx.user, communicationScope?.ownerIds ?? [], {
        participantOnlyWhenUnowned: scopeParam === MANAGER_INBOX_SCOPE,
      }) as typeof query;
      if (scopeParam) {
        query = query.eq("scope", scopeParam) as typeof query;
      }
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const fetched = (Array.isArray(data) ? data : []) as PortalInboxReadRecord[];
    const records: (PortalInboxReadRecord & { houses?: { propertyId: string; label: string }[] })[] = communicationScope
      ? await filterVisibleInboxThreadRecords(ctx.db, communicationScope, fetched)
      : fetched;
    // A notice can hold several originals from different lines/roles. Hide
    // only individual messages whose exact source, bytes and timestamp are
    // already in the ready projection; preserve annotations and unbound ones.
    let visibleRecords = records;
    if (scopeParam === MANAGER_INBOX_SCOPE) {
      const { data: cutover } = await ctx.db.from("sms_projection_cutover").select("ready").eq("singleton", true).maybeSingle();
      const notices = records.filter((record) => storedSmsNoticeIdentity({
        id: record.id,
        owner_user_id: record.owner_user_id,
        scope: record.scope,
        thread_type: record.thread_type,
        row_data: record.row_data as Record<string, unknown> | null,
      }));
      if (cutover?.ready === true && notices.length) {
        type Marker = { sourceNamespace: string; sourceEventId: string; ownerManagerUserId: string; counterpartyRole: string; workLineId: string; occurredAt: string; bodySha256: string };
        const asMarker = (value: unknown): Marker | null => {
          if (!value || typeof value !== "object") return null;
          const marker = value as Marker;
          return marker.sourceNamespace && marker.sourceEventId && marker.ownerManagerUserId && marker.counterpartyRole && marker.workLineId && marker.occurredAt && marker.bodySha256 ? marker : null;
        };
        const markers = notices.flatMap((record) => {
          const row = record.row_data as Record<string, unknown> | null;
          const root = asMarker(row?.rootOriginalSmsEvent);
          const messages = Array.isArray(row?.messages) ? row.messages as Record<string, unknown>[] : [];
          return [...(root ? [root] : []), ...messages.map((message) => asMarker(message.originalSmsEvent)).filter((marker): marker is Marker => marker !== null)];
        });
        const sourceIds = [...new Set(markers.map((marker) => marker.sourceEventId))];
        const { data: turns, error: turnsError } = sourceIds.length
          ? await ctx.db.from("sms_projection_turns").select("owner_manager_user_id,source_namespace,source_event_id,conversation_id,body,occurred_at")
            .in("source_event_id", sourceIds).limit(1000)
          : { data: [], error: null };
        if (turnsError) throw new Error("Could not verify SMS notice originals.");
        const { data: deleted, error: deletedError } = sourceIds.length
          ? await ctx.db.from("sms_projection_deleted_events")
            .select("owner_manager_user_id,source_namespace,source_event_id").in("source_event_id", sourceIds).limit(1000)
          : { data: [], error: null };
        if (deletedError) throw new Error("Could not verify deleted SMS originals.");
        const conversationIds = [...new Set((turns ?? []).map((turn) => String(turn.conversation_id)))];
        const { data: summaries, error: summariesError } = conversationIds.length
          ? await ctx.db.from("sms_projection_conversations").select("id,owner_manager_user_id,counterparty_role,work_line_id,work_line_phone,identity_key,identity_kind,counterparty_user_id,counterparty_phone,legacy_conversation_key,metadata").in("id", conversationIds)
          : { data: [], error: null };
        if (summariesError) throw new Error("Could not verify SMS notice originals.");
        const summaryById = new Map((summaries ?? []).map((summary) => [String(summary.id), summary]));
        const visibilityCandidates: SmsProjectionSummary[] = (summaries ?? []).map((summary) => ({
          id: String(summary.id), ownerManagerUserId: String(summary.owner_manager_user_id),
          counterpartyRole: summary.counterparty_role, workLineId: summary.work_line_id,
          workLinePhone: String(summary.work_line_phone ?? ""), identityKey: String(summary.identity_key),
          identityKind: summary.identity_kind, counterpartyUserId: summary.counterparty_user_id,
          phone: summary.counterparty_phone, legacyKey: summary.legacy_conversation_key,
          lastBody: "", lastDirection: null, lastEventAt: null, lastEventId: null,
          lastInboundAt: null, lastInboundEventId: null, count: 0, metadata: summary.metadata ?? {},
        }));
        // A notice grant and its replacement's grant are independent. On a
        // failed visibility check, preserve the original instead of hiding it.
        const visibleReplacementIds = new Set<string>();
        for (let offset = 0; offset < visibilityCandidates.length; offset += 40) {
          // The resolver bounds one authorization batch; every exact marker
          // still needs a chance to suppress its authorized replacement.
          const batch = await visibleManagerSmsProjectionIds(ctx.db, ctx.user.id,
            visibilityCandidates.slice(offset, offset + 40)).catch(() => new Set<string>());
          for (const id of batch) visibleReplacementIds.add(id);
        }
        const projected = new Set<string>();
        for (const turn of turns ?? []) {
          const summary = summaryById.get(String(turn.conversation_id));
          const bodySha256 = createHash("sha256").update(String(turn.body ?? "")).digest("hex");
          for (const marker of markers) {
            // A co-manager's notice can be visible under a different grant
            // than the owner's projected thread. Keep that copy until its
            // projected visibility is independently proven.
            if (visibleReplacementIds.has(String(turn.conversation_id)) && marker.ownerManagerUserId === turn.owner_manager_user_id && marker.sourceNamespace === turn.source_namespace
              && marker.sourceEventId === turn.source_event_id && marker.counterpartyRole === summary?.counterparty_role
              && marker.workLineId === summary?.work_line_id && Date.parse(marker.occurredAt) === Date.parse(String(turn.occurred_at))
              && marker.bodySha256 === bodySha256) {
              projected.add(`${marker.ownerManagerUserId}\0${marker.sourceNamespace}\0${marker.sourceEventId}`);
            }
          }
        }
        for (const event of deleted ?? []) {
          for (const marker of markers) {
            if (marker.ownerManagerUserId === ctx.user.id && marker.ownerManagerUserId === event.owner_manager_user_id &&
              marker.sourceNamespace === event.source_namespace && marker.sourceEventId === event.source_event_id) {
              projected.add(`${marker.ownerManagerUserId}\0${marker.sourceNamespace}\0${marker.sourceEventId}`);
            }
          }
        }
        const isProjected = (marker: Marker | null) => marker && projected.has(`${marker.ownerManagerUserId}\0${marker.sourceNamespace}\0${marker.sourceEventId}`);
        visibleRecords = notices.length ? records.flatMap((record) => {
          if (!notices.includes(record)) return [record];
          const row = record.row_data as Record<string, unknown> | null;
          if (!row) return [record];
          const remaining = (Array.isArray(row.messages) ? row.messages as Record<string, unknown>[] : [])
            .filter((message) => !isProjected(asMarker(message.originalSmsEvent)));
          if (!isProjected(asMarker(row.rootOriginalSmsEvent))) {
            const latest = remaining.at(-1);
            return [{ ...record, row_data: { ...row, messages: remaining,
              preview: String(latest?.body ?? row.body ?? "").slice(0, 100),
              time: latest?.at ?? row.rootAt ?? row.time } }];
          }
          const [first, ...rest] = remaining;
          if (!first) return [];
          const latest = rest.at(-1) ?? first;
          return [{ ...record, row_data: { ...row, rootMessageId: first.id, rootAt: first.at,
            rootOriginalSmsEvent: first.originalSmsEvent, body: first.body, from: first.from,
            messages: rest, preview: String(latest.body ?? "").slice(0, 100), time: latest.at ?? first.at } }];
        }) : records;
      }
    }
    const rows = visibleRecords.map((record) => {
      const row = (record.row_data && typeof record.row_data === "object" ? record.row_data : record) as Record<string, unknown>;
      return { ...normalizeInboxRow({ ...row, id: record.id, ownerUserId: record.owner_user_id, threadType: record.thread_type, ...(record.houses ? { houses: record.houses } : {}) }), readSources: [{ id: record.id, observation: portalInboxReadObservation(record), unread: row?.unread === true }], readSourcesComplete: true };
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
      action?: "upsert" | "delete" | "deleteIds" | "replace" | "changeFolder" | "markRead";
      scope?: string;
      folderAction?: "archive" | "restore";
      id?: string;
      ids?: unknown[];
      row?: Record<string, unknown>;
      rows?: Record<string, unknown>[];
      sources?: { id?: unknown; observation?: unknown }[];
    };

    const scopeKey = String(
      body.action === "replace"
        ? (body.rows?.[0]?.scope ?? "")
        : body.action === "upsert"
          ? (body.row?.scope ?? "")
          : body.action === "changeFolder" || body.action === "markRead" ? body.scope : "",
    ).trim();

    const ctx = await resolveInboxScopeUser(scopeKey);
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    if (body.action === "markRead") {
      if (scopeKey !== MANAGER_INBOX_SCOPE) return NextResponse.json({ error: "Unsupported scope." }, { status: 400 });
      const sources = Array.isArray(body.sources) ? body.sources : [];
      if (sources.length === 0 || sources.length > 500) return NextResponse.json({ error: "Choose up to 500 sources." }, { status: 400 });
      const requested = new Map<string, string>();
      for (const source of sources) {
        const id = typeof source.id === "string" ? source.id.trim() : "";
        const observation = typeof source.observation === "string" ? source.observation.trim() : "";
        if (!id || !observation || id.length > 200 || observation.length > 128 || requested.has(id)) return NextResponse.json({ error: "Invalid sources." }, { status: 400 });
        requested.set(id, observation);
      }
      const ids = [...requested.keys()];
      const editScope = await resolveCommunicationScope(ctx.db, ctx.user.id, "edit");
      const extraOwnerIds = editScope.ownerIds;
      let query = ctx.db.from("portal_inbox_thread_records").select("id, scope, row_data, updated_at, owner_user_id, participant_email, thread_type").in("id", ids);
      query = applyPortalInboxThreadScope(query, ctx.user, extraOwnerIds, { participantOnlyWhenUnowned: true }) as typeof query;
      const { data, error } = await query;
      if (error) throw error;
      const records: PortalInboxReadRecord[] = await filterVisibleInboxThreadRecords(
        ctx.db,
        editScope,
        (Array.isArray(data) ? data : []) as PortalInboxReadRecord[],
      );
      if (records.length !== ids.length || records.some((record) => record.scope !== scopeKey)) return NextResponse.json({ error: "Record not found." }, { status: 404 });
      const results = [] as { id: string; status: "read" | "alreadyRead" | "changed" | "archived" | "failed"; unread: boolean }[];
      let failed = false;
      for (const initialRecord of records) {
        try {
          let record = initialRecord;
          let row = record.row_data as Record<string, unknown>;
          if (row?.folder === "trash") { results.push({ id: record.id, status: "archived", unread: false }); continue; }
          if (row?.unread !== true) { results.push({ id: record.id, status: "alreadyRead", unread: false }); continue; }
          if (portalInboxReadObservation(record) !== requested.get(record.id)) { results.push({ id: record.id, status: "changed", unread: row?.unread === true }); continue; }
          let changed = false;
          for (let attempt = 0; attempt < 2 && !changed; attempt += 1) {
            const result = await ctx.db.rpc("mark_portal_inbox_source_read", { p_id: record.id, p_scope: record.scope, p_owner_user_id: record.owner_user_id, p_participant_email: record.participant_email, p_thread_type: record.thread_type, p_updated_at: record.updated_at, p_row_data: record.row_data });
            if (result.error) throw result.error;
            changed = result.data === true;
            if (changed || attempt === 1) break;
            let retryQuery = ctx.db.from("portal_inbox_thread_records").select("id, scope, row_data, updated_at, owner_user_id, participant_email, thread_type").eq("id", record.id).eq("scope", scopeKey);
            retryQuery = applyPortalInboxThreadScope(retryQuery, ctx.user, extraOwnerIds, { participantOnlyWhenUnowned: true }) as typeof retryQuery;
            const { data: retryData, error: retryError } = await retryQuery.maybeSingle();
            if (retryError) throw retryError;
            if (!retryData) { results.push({ id: record.id, status: "changed", unread: true }); break; }
            record = retryData as PortalInboxReadRecord;
            row = record.row_data as Record<string, unknown>;
            if (row?.folder === "trash") { results.push({ id: record.id, status: "archived", unread: false }); break; }
            if (row?.unread !== true) { results.push({ id: record.id, status: "alreadyRead", unread: false }); break; }
            if (portalInboxReadObservation(record) !== requested.get(record.id)) { results.push({ id: record.id, status: "changed", unread: true }); break; }
          }
          if (!results.some((result) => result.id === record.id)) results.push({ id: record.id, status: changed ? "read" : "changed", unread: !changed });
        } catch {
          failed = true;
          const row = initialRecord.row_data as Record<string, unknown>;
          results.push({ id: initialRecord.id, status: "failed", unread: row?.unread === true });
        }
      }
      return NextResponse.json({ ok: !failed, results }, { status: failed ? 500 : 200 });
    }

    if (body.action === "changeFolder") {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String).map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0 || ids.length > 100 || !["archive", "restore"].includes(body.folderAction ?? "")) {
        return NextResponse.json({ error: "Choose conversations and an action." }, { status: 400 });
      }
      const folderScope = scopeKey === MANAGER_INBOX_SCOPE
        ? await resolveCommunicationScope(ctx.db, ctx.user.id, "edit")
        : null;
      let query = ctx.db.from("portal_inbox_thread_records")
        .select("id, owner_user_id, participant_email, thread_type, scope, row_data").in("id", ids);
      query = applyPortalInboxThreadScope(query, ctx.user, folderScope?.ownerIds ?? [], {
        participantOnlyWhenUnowned: scopeKey === MANAGER_INBOX_SCOPE,
      }) as typeof query;
      const { data: fetchedFolderRows, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      type FolderRow = { id: string; owner_user_id: string | null; participant_email: string | null; thread_type?: string | null; scope: string; row_data: Record<string, unknown> | null };
      const data: FolderRow[] | null = folderScope
        ? await filterVisibleInboxThreadRecords(ctx.db, folderScope, (fetchedFolderRows ?? []) as FolderRow[])
        : ((fetchedFolderRows ?? []) as FolderRow[]);
      // Act on the ids this viewer can see. A collapsed person-row keeps
      // `sourceThreadIds` from an earlier merge, and one of those can name a
      // record the list no longer returns (deleted, or since hidden by house
      // scope). Refusing the whole batch for that one id left the conversation
      // un-archivable from every surface; skipping it changes nothing for the
      // record that was not visible anyway.
      if (!data || data.length === 0 || data.some((row) => row.scope !== scopeKey)) {
        return NextResponse.json({ error: "Record not found." }, { status: 404 });
      }
      if (data.some((row) => storedSmsNoticeIdentity(row))) {
        return NextResponse.json({ error: "Use the SMS archive action." }, { status: 400 });
      }
      const result = await ctx.db.rpc("change_portal_inbox_thread_folders", {
        p_ids: data.map((row) => row.id), p_scope: scopeKey, p_action: body.folderAction,
      });
      if (result.error) throw result.error;
      if (result.data !== "ok") return NextResponse.json({ error: "Conversations changed. Refresh and try again." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete" || body.action === "deleteIds") {
      const ids =
        body.action === "deleteIds"
          ? (Array.isArray(body.ids) ? body.ids.map(String) : [])
          : [body.id?.trim() ?? ""];
      if (ids.length === 0 || ids.some((id) => !id)) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      const deleteScope =
        scopeKey === MANAGER_INBOX_SCOPE
          ? await resolveCommunicationScope(ctx.db, ctx.user.id, "delete")
          : null;
      const extraOwnerIds = deleteScope?.ownerIds ?? [];
      const scopeOptions = { participantOnlyWhenUnowned: scopeKey === MANAGER_INBOX_SCOPE };
      let deleted = 0;
      for (const id of ids) {
        let targetQuery = ctx.db.from("portal_inbox_thread_records")
          .select("id, owner_user_id, participant_email, scope, thread_type, row_data").eq("id", id);
        targetQuery = applyPortalInboxThreadScope(targetQuery, ctx.user, extraOwnerIds, scopeOptions) as typeof targetQuery;
        const { data: fetchedTarget, error: targetError } = await targetQuery.maybeSingle();
        if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
        if (!fetchedTarget) continue;
        // A thread the viewer cannot list is not theirs to delete either.
        type DeleteRow = { id: string; owner_user_id: string | null; participant_email: string | null; thread_type?: string | null; scope: string; row_data: Record<string, unknown> | null };
        const target: DeleteRow | undefined = deleteScope
          ? (await filterVisibleInboxThreadRecords(ctx.db, deleteScope, [fetchedTarget as DeleteRow]))[0]
          : (fetchedTarget as DeleteRow);
        if (!target) continue;
        const members = await smsNoticeMembers(ctx.db, target);
        let deleteQuery = ctx.db.from("portal_inbox_thread_records").delete().in("id", members.map((m) => m.id)).select("id");
        deleteQuery = applyPortalInboxThreadScope(deleteQuery, ctx.user, extraOwnerIds, scopeOptions) as typeof deleteQuery;
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
        .select("id, owner_user_id, participant_email, scope, thread_type, row_data")
        .eq("id", id)
        .limit(1);
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });

      const recordExists = Array.isArray(existing) && existing.length > 0;
      if (recordExists) {
        const upsertScope =
          scopeKey === MANAGER_INBOX_SCOPE
            ? await resolveCommunicationScope(ctx.db, ctx.user.id, "edit")
            : null;
        let visibleQuery = ctx.db.from("portal_inbox_thread_records").select("id").eq("id", id).limit(1);
        visibleQuery = applyPortalInboxThreadScope(visibleQuery, ctx.user, upsertScope?.ownerIds ?? [], {
          participantOnlyWhenUnowned: scopeKey === MANAGER_INBOX_SCOPE,
        }) as typeof visibleQuery;
        const { data: visible, error: visibleError } = await visibleQuery;
        if (visibleError) return NextResponse.json({ error: visibleError.message }, { status: 500 });
        if (!Array.isArray(visible) || visible.length === 0) {
          return NextResponse.json({ error: "Record not found." }, { status: 404 });
        }
        // Owner scope found it; the house / workspace rule still has to allow it.
        if (upsertScope) {
          const allowed = await filterVisibleInboxThreadRecords(ctx.db, upsertScope, [
            existing[0] as { id: string; owner_user_id: string | null; participant_email: string | null; thread_type?: string | null; row_data: unknown },
          ]);
          if (allowed.length === 0) return NextResponse.json({ error: "Record not found." }, { status: 404 });
        }

        if (storedSmsNoticeIdentity(existing[0])) {
          await updateSmsNoticeMailboxState(ctx.db, existing[0], normalized);
          continue;
        }
        if ((existing[0] as { thread_type?: string | null }).thread_type === "team" || isTeamThreadId(id)) {
          await updateTeamThreadMailboxState(ctx.db, { id }, normalized);
          continue;
        }

        const prior = existing[0] as {
          owner_user_id?: string | null;
          participant_email?: string | null;
          scope?: string | null;
        };
        record.owner_user_id = prior.owner_user_id ?? record.owner_user_id;
        record.participant_email = record.participant_email ?? prior.participant_email ?? null;
        record.scope = prior.scope ?? record.scope;
      } else if (isTeamThreadId(id)) {
        continue;
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
