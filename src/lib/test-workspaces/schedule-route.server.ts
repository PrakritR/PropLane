import { NextResponse } from "next/server";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { asStringArray, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isTestWorkspaceFeatureEnabled,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";
import {
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
} from "@/lib/portal-schedule-record-scope";
import { replaceManagerPlannedScheduleSlice } from "@/lib/planned-schedule-persistence.server";

type TestScheduleLink = {
  inviter_user_id: string | null;
  assigned_property_ids: unknown;
  property_co_manager_permissions: unknown;
  co_manager_permissions: unknown;
  house_scope?: string | null;
  team_role?: string | null;
};

type TestScheduleProperty = {
  id: string;
  manager_user_id: string | null;
};

type TestScheduleWriteBody = {
  action?: unknown;
  id?: unknown;
  ids?: unknown;
  row?: Record<string, unknown>;
  rows?: unknown;
  expectedPayloadKnown?: unknown;
  expectedPayload?: unknown;
};

const TEST_SCHEDULE_SHARED_RECORD_IDS = new Set([
  "axis_admin_planned_events_v1",
  "axis_admin_partner_inquiries_v1",
]);

function propertyIdFromEvent(event: Record<string, unknown>): string {
  return String(event.propertyId ?? event.property_id ?? "").trim();
}

function eventId(event: Record<string, unknown>): string {
  return String(event.id ?? "").trim();
}

function eventManagerUserId(event: Record<string, unknown>): string {
  return String(event.managerUserId ?? event.manager_user_id ?? "").trim();
}

function isTourEvent(event: Record<string, unknown>): boolean {
  return String(event.kind ?? "").trim() === "tour";
}

function sameScheduleEvent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameScheduleEvent(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameScheduleEvent(leftRecord[key], rightRecord[key]));
}

function propertyAccessAllowed(args: {
  actorUserId: string;
  propertyId: string;
  propertyOwners: Map<string, string>;
  links: TestScheduleLink[];
  level: "read" | "edit";
}): boolean {
  const ownerId = args.propertyOwners.get(args.propertyId);
  if (!ownerId) return false;
  if (ownerId === args.actorUserId) return true;
  return args.links.some((link) => {
    if (String(link.inviter_user_id ?? "").trim() !== ownerId) return false;
    const assigned = asStringArray(link.assigned_property_ids).map((id) => id.trim());
    if (!assigned.includes(args.propertyId)) return false;
    const permissions = readPropertyPermissionsFromRow({
      assigned_property_ids: assigned,
      property_co_manager_permissions: link.property_co_manager_permissions,
      co_manager_permissions: link.co_manager_permissions,
      house_scope: link.house_scope,
      team_role: link.team_role,
    });
    return coManagerModuleAllowed(permissions, args.propertyId, "calendar", args.level);
  });
}

async function loadTestScheduleProperties(
  ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; workspaceId: string },
  propertyIds: Set<string>,
): Promise<Map<string, string>> {
  if (propertyIds.size === 0) return new Map();
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id,manager_user_id")
    .eq("test_workspace_id", ctx.workspaceId)
    .in("id", [...propertyIds]);
  if (error) throw new Error("Failed to verify schedule properties.");
  return new Map(
    ((data ?? []) as TestScheduleProperty[])
      .map((property) => [String(property.id ?? "").trim(), String(property.manager_user_id ?? "").trim()] as const)
      .filter(([propertyId, managerUserId]) => Boolean(propertyId && managerUserId)),
  );
}

function testScheduleLinks(rows: unknown[]): TestScheduleLink[] {
  return rows.map((row) => row as TestScheduleLink);
}

function recordTypeFromRow(row: Record<string, unknown>): string {
  return String(row.recordType ?? row.record_type ?? "").trim();
}

function isOwnedTestScheduleRecord(row: Record<string, unknown>, userId: string): boolean {
  const id = String(row.id ?? "").trim();
  const recordType = recordTypeFromRow(row);
  if (!id || TEST_SCHEDULE_SHARED_RECORD_IDS.has(id)) return false;
  if (recordType === "manager_tasks") return id === `axis_manager_tasks_v1_${userId}`;
  return isManagerScopedScheduleRecordType(recordType) && managerScheduleRecordIdOwnedByUser(id, userId, recordType);
}

function testScheduleRecord(row: Record<string, unknown>, ctx: { userId: string; workspaceId: string }) {
  const recordType = recordTypeFromRow(row);
  return {
    id: String(row.id).trim(),
    manager_user_id: ctx.userId,
    property_id: propertyIdFromEvent(row) || null,
    record_type: recordType,
    starts_at: row.startsAt ?? row.starts_at ?? row.startIso ?? null,
    ends_at: row.endsAt ?? row.ends_at ?? row.endIso ?? null,
    row_data: { ...row, managerUserId: ctx.userId },
    test_workspace_id: ctx.workspaceId,
    updated_at: new Date().toISOString(),
  };
}


async function resolveTestScheduleContext() {
  const portal = await getPortalAccessContext();
  if (!portal.user) return { kind: "anonymous" as const };
  const classification = await resolveTestWorkspaceClassification(portal.user.id);
  if (classification.kind === "normal") return { kind: "normal" as const };
  if (!isTestWorkspaceFeatureEnabled() || classification.state !== "active") {
    return { kind: "denied" as const };
  }
  if (classification.role !== "manager" && classification.role !== "co_manager") {
    return { kind: "denied" as const };
  }
  return {
    kind: "test" as const,
    userId: portal.user.id,
    workspaceId: classification.workspaceId,
    db: createSupabaseServiceRoleClient(),
  };
}

export async function handleTestWorkspaceScheduleGet(fallback: () => Promise<Response>) {
  const ctx = await resolveTestScheduleContext();
  if (ctx.kind === "normal" || ctx.kind === "anonymous") return fallback();
  if (ctx.kind === "denied") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const [planned, owned, grants] = await Promise.all([
    ctx.db.from("test_workspace_schedule_records").select("row_data").eq("workspace_id", ctx.workspaceId).eq("record_key", "planned_events").maybeSingle(),
    ctx.db.from("portal_schedule_records").select("id,row_data,updated_at").eq("test_workspace_id", ctx.workspaceId).eq("manager_user_id", ctx.userId).order("updated_at", { ascending: false }).limit(500),
    ctx.db.from("account_link_invites").select("inviter_user_id,assigned_property_ids,property_co_manager_permissions,co_manager_permissions,house_scope,team_role").eq("test_workspace_id", ctx.workspaceId).eq("invitee_user_id", ctx.userId).eq("status", "accepted"),
  ]);
  if (planned.error || owned.error || grants.error) {
    return NextResponse.json({ error: "Failed to load schedule." }, { status: 500 });
  }
  const plannedRow = planned.data?.row_data && typeof planned.data.row_data === "object"
    ? planned.data.row_data as Record<string, unknown>
    : { id: "axis_admin_planned_events_v1", recordType: "axis_admin_planned_events_v1", payload: [] };
  const plannedPayload = Array.isArray(plannedRow.payload) ? plannedRow.payload : [];
  const events = plannedPayload.filter((event): event is Record<string, unknown> => Boolean(event && typeof event === "object" && !Array.isArray(event)));
  let propertyOwners: Map<string, string>;
  try {
    propertyOwners = await loadTestScheduleProperties(
      ctx,
      new Set(events.map(propertyIdFromEvent).filter(Boolean)),
    );
  } catch {
    return NextResponse.json({ error: "Failed to load schedule." }, { status: 500 });
  }
  const links = testScheduleLinks(grants.data ?? []);
  const visiblePayload = plannedPayload.filter((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const row = event as Record<string, unknown>;
    const propertyId = propertyIdFromEvent(row);
    if (String(row.managerUserId ?? "") === ctx.userId) {
      return !propertyId || propertyAccessAllowed({
        actorUserId: ctx.userId,
        propertyId,
        propertyOwners,
        links,
        level: "read",
      });
    }
    return Boolean(propertyId) && propertyAccessAllowed({
      actorUserId: ctx.userId,
      propertyId,
      propertyOwners,
      links,
      level: "read",
    });
  });
  const rows = [{ ...plannedRow, payload: visiblePayload }, ...(owned.data ?? []).map((row) => row.row_data ?? row)];
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function handleTestWorkspaceSchedulePost(req: Request, fallback: (req: Request) => Promise<Response>) {
  const ctx = await resolveTestScheduleContext();
  if (ctx.kind !== "test") {
    if (ctx.kind === "denied") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    return fallback(req);
  }
  let body: TestScheduleWriteBody;
  try {
    const parsed: unknown = await req.clone().json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Test workspace schedule writes require exactly one owned record." }, { status: 400 });
    }
    body = parsed as TestScheduleWriteBody;
  } catch {
    return NextResponse.json({ error: "Test workspace schedule writes require exactly one owned record." }, { status: 400 });
  }
  const action = body.action ?? "upsert";
  if (!["upsert", "replace", "delete", "deleteIds"].includes(String(action))) {
    return NextResponse.json({ error: "Unsupported test workspace schedule action." }, { status: 400 });
  }
  if (action === "delete" || action === "deleteIds") {
    const ids = action === "delete"
      ? [typeof body.id === "string" ? body.id.trim() : ""]
      : Array.isArray(body.ids) ? body.ids.map((id) => typeof id === "string" ? id.trim() : "") : [];
    if (ids.length !== 1 || !ids[0] || TEST_SCHEDULE_SHARED_RECORD_IDS.has(ids[0])) {
      return NextResponse.json({ error: "Test workspace schedule deletes require exactly one owned record." }, { status: 400 });
    }
    const { data: existing, error: existingError } = await ctx.db
      .from("portal_schedule_records")
      .select("id,record_type,manager_user_id,test_workspace_id")
      .eq("id", ids[0])
      .maybeSingle();
    if (existingError) return NextResponse.json({ error: "Failed to verify schedule record." }, { status: 500 });
    const stored = existing as Record<string, unknown> | null;
    if (
      !stored ||
      String(stored.test_workspace_id ?? "") !== ctx.workspaceId ||
      String(stored.manager_user_id ?? "") !== ctx.userId ||
      !isOwnedTestScheduleRecord({ id: stored.id, record_type: stored.record_type }, ctx.userId)
    ) {
      return NextResponse.json({ error: "Record not found." }, { status: 404 });
    }
    const { data: deleted, error: deleteError } = await ctx.db
      .from("portal_schedule_records")
      .delete()
      .eq("id", ids[0])
      .eq("test_workspace_id", ctx.workspaceId)
      .eq("manager_user_id", ctx.userId)
      .select("id");
    if (deleteError) return NextResponse.json({ error: "Failed to delete schedule record." }, { status: 500 });
    if (!deleted || deleted.length !== 1) return NextResponse.json({ error: "Record not found." }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: 1 });
  }
  const replacementRows = Array.isArray(body.rows) ? body.rows : null;
  if (
    (action === "upsert" && (!body.row || body.rows !== undefined)) ||
    (action === "replace" && (!replacementRows || replacementRows.length !== 1 || body.row !== undefined))
  ) {
    return NextResponse.json({ error: "Test workspace schedule writes require exactly one owned record." }, { status: 400 });
  }
  const candidate = action === "replace" ? replacementRows?.[0] : body.row;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return NextResponse.json({ error: "Test workspace schedule writes require exactly one owned record." }, { status: 400 });
  }
  if (String(candidate.managerUserId ?? candidate.manager_user_id ?? "") && String(candidate.managerUserId ?? candidate.manager_user_id) !== ctx.userId) {
    return NextResponse.json({ error: "Test workspace schedule records must belong to the authenticated manager." }, { status: 403 });
  }
  if (String(candidate.id ?? "") === "axis_admin_planned_events_v1") {
    return replaceTestWorkspacePlannedEvents(ctx, candidate, {
      expectedPayloadKnown: body.expectedPayloadKnown === true,
      expectedPayload: body.expectedPayload,
    });
  }
  if (!isOwnedTestScheduleRecord(candidate, ctx.userId)) {
    return NextResponse.json({ error: "Test workspace schedule writes require an owned availability or task record." }, { status: 403 });
  }
  const propertyId = propertyIdFromEvent(candidate);
  let propertyOwners: Map<string, string>;
  let grantRows: unknown[];
  try {
    const [grants, owners] = await Promise.all([
      ctx.db.from("account_link_invites").select("inviter_user_id,assigned_property_ids,property_co_manager_permissions,co_manager_permissions,house_scope,team_role").eq("test_workspace_id", ctx.workspaceId).eq("invitee_user_id", ctx.userId).eq("status", "accepted"),
      loadTestScheduleProperties(ctx, new Set(propertyId ? [propertyId] : [])),
    ]);
    if (grants.error) return NextResponse.json({ error: "Failed to verify schedule access." }, { status: 500 });
    propertyOwners = owners;
    grantRows = grants.data ?? [];
  } catch {
    return NextResponse.json({ error: "Failed to verify schedule access." }, { status: 500 });
  }
  if (propertyId && !propertyAccessAllowed({
    actorUserId: ctx.userId,
    propertyId,
    propertyOwners,
    links: testScheduleLinks(grantRows),
    level: "edit",
  })) {
    return NextResponse.json({ error: "You do not have edit access to this schedule property." }, { status: 403 });
  }
  const { data: existing, error: existingError } = await ctx.db
    .from("portal_schedule_records")
    .select("id,test_workspace_id,manager_user_id")
    .eq("id", String(candidate.id).trim())
    .maybeSingle();
  if (existingError) return NextResponse.json({ error: "Failed to verify schedule record." }, { status: 500 });
  const stored = existing as Record<string, unknown> | null;
  if (stored && (
    String(stored.test_workspace_id ?? "") !== ctx.workspaceId ||
    String(stored.manager_user_id ?? "") !== ctx.userId
  )) {
    return NextResponse.json({ error: "Record not found." }, { status: 404 });
  }
  const record = testScheduleRecord(candidate, ctx);
  const write = stored
    ? ctx.db.from("portal_schedule_records").update(record).eq("id", record.id).eq("test_workspace_id", ctx.workspaceId).eq("manager_user_id", ctx.userId)
    : ctx.db.from("portal_schedule_records").insert(record);
  const { error: writeError } = await write;
  if (writeError) return NextResponse.json({ error: "Failed to save schedule record." }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function replaceTestWorkspacePlannedEvents(
  ctx: Extract<Awaited<ReturnType<typeof resolveTestScheduleContext>>, { kind: "test" }>,
  candidate: Record<string, unknown>,
  observed: { expectedPayloadKnown: boolean; expectedPayload: unknown },
) {
  if (!Array.isArray(candidate.payload)) {
    return NextResponse.json({ error: "Test workspace planned events require a payload." }, { status: 400 });
  }
  if (candidate.payload.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    return NextResponse.json({ error: "Test workspace schedule events must be objects." }, { status: 400 });
  }
  const events = candidate.payload as Record<string, unknown>[];
  if (!observed.expectedPayloadKnown || !Array.isArray(observed.expectedPayload)) {
    return NextResponse.json({ error: "Calendar changed. Refresh and try again." }, { status: 409 });
  }
  const observedEvents = observed.expectedPayload.filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  const current = await ctx.db
    .from("test_workspace_schedule_records")
    .select("row_data")
    .eq("workspace_id", ctx.workspaceId)
    .eq("record_key", "planned_events")
    .maybeSingle();
  if (current.error) return NextResponse.json({ error: "Failed to load schedule." }, { status: 500 });
  const currentPayload = current.data?.row_data && typeof current.data.row_data === "object"
    ? (current.data.row_data as { payload?: unknown }).payload
    : [];
  const currentEvents = (Array.isArray(currentPayload) ? currentPayload : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const currentActorEvents = currentEvents.filter((item) => eventManagerUserId(item) === ctx.userId);
  const observedActorEvents = observedEvents.filter((item) => eventManagerUserId(item) === ctx.userId);
  const currentById = new Map(
    currentEvents
      .map((item) => [eventId(item), item] as const)
      .filter(([id]) => Boolean(id)),
  );
  // Resolve both the current actor slice and the submitted cache. This makes a
  // revoked event safe to retain, and checks a move against its old and new home.
  const propertyIds = new Set([
    ...currentActorEvents.map(propertyIdFromEvent),
    ...events.map(propertyIdFromEvent),
  ].filter(Boolean));
  let grantRows: unknown[];
  let propertyOwners: Map<string, string>;
  try {
    const [grants, owners] = await Promise.all([
      ctx.db.from("account_link_invites").select("inviter_user_id,assigned_property_ids,property_co_manager_permissions,co_manager_permissions,house_scope,team_role").eq("test_workspace_id", ctx.workspaceId).eq("invitee_user_id", ctx.userId).eq("status", "accepted"),
      loadTestScheduleProperties(ctx, propertyIds),
    ]);
    if (grants.error) return NextResponse.json({ error: "Failed to verify schedule access." }, { status: 500 });
    grantRows = grants.data ?? [];
    propertyOwners = owners;
  } catch {
    return NextResponse.json({ error: "Failed to verify schedule access." }, { status: 500 });
  }
  const links = testScheduleLinks(grantRows ?? []);
  const mayEditProperty = (propertyId: string) => !propertyId || propertyAccessAllowed({
    actorUserId: ctx.userId,
    propertyId,
    propertyOwners,
    links,
    level: "edit",
  });
  const observedActorIds = new Set(observedActorEvents.map(eventId).filter(Boolean));
  const expectedActorEvents = [
    ...observedActorEvents,
    ...currentActorEvents.filter((stored) => {
      const id = eventId(stored);
      return Boolean(id)
        && !observedActorIds.has(id)
        && (isTourEvent(stored) || !mayEditProperty(propertyIdFromEvent(stored)));
    }),
  ];
  const submittedActorIds = new Set<string>();
  const submittedIds = new Set<string>();
  const replacementEvents: Record<string, unknown>[] = [];

  for (const submitted of events) {
    const id = eventId(submitted);
    if (!id) {
      return NextResponse.json({ error: "Test workspace schedule events require an id." }, { status: 400 });
    }
    if (submittedIds.has(id)) {
      return NextResponse.json({ error: "Test workspace schedule events cannot include duplicate ids." }, { status: 400 });
    }
    submittedIds.add(id);
    const stored = id ? currentById.get(id) : undefined;
    if (stored && isTourEvent(stored)) {
      // Confirmed tours are lifecycle-owned by their cancel/reschedule routes.
      // Preserve the durable row even if a generic client snapshot omits or
      // changes it.
      submittedActorIds.add(id);
      replacementEvents.push(stored);
      continue;
    }
    if (isTourEvent(submitted)) {
      return NextResponse.json({ error: "Tours must be changed through their dedicated lifecycle routes." }, { status: 403 });
    }
    if (stored && eventManagerUserId(stored) !== ctx.userId) {
      // Linked-owner rows are read context. An unchanged echo is harmless, but
      // this endpoint never accepts a client-authored replacement for one.
      if (!sameScheduleEvent(submitted, stored)) {
        return NextResponse.json({ error: "Linked schedule events cannot be changed." }, { status: 403 });
      }
      continue;
    }
    const submittedManagerId = eventManagerUserId(submitted);
    if (submittedManagerId && submittedManagerId !== ctx.userId) {
      return NextResponse.json({ error: "Test workspace schedule events must belong to the authenticated manager." }, { status: 403 });
    }
    submittedActorIds.add(id);
    if (stored) {
      const normalized = { ...submitted, managerUserId: ctx.userId };
      if (sameScheduleEvent(normalized, stored)) {
        replacementEvents.push(stored);
        continue;
      }
      if (!mayEditProperty(propertyIdFromEvent(stored)) || !mayEditProperty(propertyIdFromEvent(submitted))) {
        return NextResponse.json({ error: "You do not have edit access to this schedule property." }, { status: 403 });
      }
      replacementEvents.push(normalized);
      continue;
    }
    if (!mayEditProperty(propertyIdFromEvent(submitted))) {
      return NextResponse.json({ error: "You do not have edit access to this schedule property." }, { status: 403 });
    }
    replacementEvents.push({ ...submitted, managerUserId: ctx.userId });
  }

  for (const stored of currentActorEvents) {
    const id = eventId(stored);
    if (id && submittedActorIds.has(id)) continue;
    // An event that disappeared from a co-manager's visible cache after a
    // revocation is not an authorized deletion. Preserve the server row.
    if (isTourEvent(stored) || !mayEditProperty(propertyIdFromEvent(stored))) replacementEvents.push(stored);
  }
  const result = await replaceManagerPlannedScheduleSlice(ctx.db, {
    managerUserId: ctx.userId,
    testWorkspaceId: ctx.workspaceId,
    events: replacementEvents,
    expectedEvents: expectedActorEvents,
  });
  if (!result.available) return NextResponse.json({ error: "Schedule storage unavailable." }, { status: 503 });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
  return NextResponse.json({ ok: true });
}
