import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { conversationVisible, resolveCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { loadWorkspaceHouseLabels } from "@/lib/manager-sms-messages.server";
import { managerSmsContactKey } from "@/lib/sms/manager-sms-contacts.server";
import type { ManagerSmsMessageRow, ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import {
  getSmsProjectionTurns,
  listSmsProjectionConversations,
  loadSmsProjectionViewStates,
  type SmsProjectionCursor,
  type SmsProjectionSummary,
  type SmsProjectionTurn,
  type SmsProjectionViewState,
} from "@/lib/sms/sms-projection.server";
import { resolveViewerWorkNumber } from "@/lib/sms/manager-workspace-role.server";
import { isTwilioMessageSid } from "@/lib/sms/message-sid";

const PAGE_SIZE = 40;

function tupleBefore(a: SmsProjectionSummary, b: SmsProjectionSummary): number {
  const byTime = String(b.lastEventAt ?? "").localeCompare(String(a.lastEventAt ?? ""));
  return byTime || b.id.localeCompare(a.id);
}

function mapTurn(turn: SmsProjectionTurn): ManagerSmsMessageRow {
  return {
    id: turn.id,
    direction: turn.direction,
    body: turn.body,
    fromPhone: turn.fromPhone,
    toPhone: turn.toPhone ?? "",
    messageSid: turn.sourceEventId,
    source: turn.sourceNamespace.includes("relay") ? "relay" : "work_number",
    createdAt: turn.occurredAt,
  };
}

function previewTurn(summary: SmsProjectionSummary, linePhone: string | null, sourceEventId: string | null): ManagerSmsMessageRow[] {
  if (!summary.lastEventAt || !summary.lastEventId || !summary.lastDirection) return [];
  return [{
    id: summary.lastEventId,
    direction: summary.lastDirection,
    body: summary.lastBody,
    fromPhone: summary.lastDirection === "inbound" ? summary.phone : linePhone,
    toPhone: summary.lastDirection === "inbound" ? linePhone ?? "" : summary.phone ?? "",
    messageSid: sourceEventId,
    source: "work_number",
    createdAt: summary.lastEventAt,
  }];
}

function encodeCursor(cursor: SmsProjectionCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

export function decodeSmsProjectionCursor(value: string | null): SmsProjectionCursor | null {
  if (!value) return null;
  if (value.length > 300) throw new Error("Invalid conversation cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SmsProjectionCursor;
    if (!Number.isFinite(Date.parse(parsed.occurredAt)) || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid conversation cursor.");
  }
}

type Context = {
  lastSourceIds: Map<string, string>;
  aliases: Map<string, string[]>;
  houseIds: Map<string, string[]>;
  houseLabels: Map<string, string>;
  archived: Set<string>;
  residencyLabels: Map<string, string>;
  viewStates: Map<string, SmsProjectionViewState>;
  directory: Map<string, { name: string | null; email: string | null; savedName: string | null }>;
};

async function loadPageContext(db: SupabaseClient, viewerId: string, summaries: SmsProjectionSummary[]): Promise<Context> {
  const aliases = new Map<string, string[]>();
  const ids = summaries.map((summary) => summary.id);
  const owners = [...new Set(summaries.map((summary) => summary.ownerManagerUserId))];
  if (!ids.length) return { aliases, lastSourceIds: new Map(), houseIds: new Map(), houseLabels: new Map(), archived: new Set(), residencyLabels: new Map(), viewStates: new Map(), directory: new Map() };
  const lastIds = summaries.map((summary) => summary.lastEventId).filter((id): id is string => Boolean(id));
  const { data: lastTurns, error: lastTurnsError } = lastIds.length
    ? await db.from("sms_projection_turns").select("id,source_event_id").in("id", lastIds)
    : { data: [], error: null };
  if (lastTurnsError) throw new Error("Could not load SMS preview sources.");
  const lastSourceIds = new Map((lastTurns ?? []).map((turn) => [String(turn.id), String(turn.source_event_id)]));
  const { data: aliasRows, error: aliasError } = await db.from("sms_projection_aliases")
    .select("conversation_id,alias_value,alias_kind").in("conversation_id", ids);
  if (aliasError) throw new Error("Could not load SMS conversation scope.");
  for (const row of aliasRows ?? []) {
    if (row.alias_kind !== "legacy_key") continue;
    const id = String(row.conversation_id);
    aliases.set(id, [...(aliases.get(id) ?? []), String(row.alias_value)]);
  }
  const residencyLabels = new Map<string, string>();
  for (const summary of summaries) {
    if (summary.legacyKey) aliases.set(summary.id, [...new Set([...(aliases.get(summary.id) ?? []), summary.legacyKey])]);
  }
  const keys = [...new Set([...aliases.values()].flat())];
  const houseIds = new Map<string, string[]>();
  const archived = new Set<string>();
  if (keys.length) {
    const [{ data: tags, error: tagError }, { data: archivedRows, error: archiveError }] = await Promise.all([
      db.from("manager_sms_conversation_houses").select("manager_user_id,conversation_key,property_id").in("manager_user_id", owners).in("conversation_key", keys),
      db.from("manager_tour_followup_controls").select("manager_user_id,conversation_key,archived").in("manager_user_id", owners).in("conversation_key", keys),
    ]);
    if (tagError || archiveError) throw new Error("Could not load SMS conversation state.");
    const tagsByKey = new Map<string, string[]>();
    for (const tag of tags ?? []) {
      const key = `${tag.manager_user_id}\0${tag.conversation_key}`;
      tagsByKey.set(key, [...(tagsByKey.get(key) ?? []), String(tag.property_id)]);
    }
    const archiveKeys = new Set((archivedRows ?? []).filter((row) => row.archived === true).map((row) => `${row.manager_user_id}\0${row.conversation_key}`));
    for (const summary of summaries) {
      const memberKeys = aliases.get(summary.id) ?? [];
      houseIds.set(summary.id, [...new Set(memberKeys.flatMap((key) => tagsByKey.get(`${summary.ownerManagerUserId}\0${key}`) ?? []))]);
      if (memberKeys.some((key) => archiveKeys.has(`${summary.ownerManagerUserId}\0${key}`))) archived.add(summary.id);
    }
  }
  const userIds = [...new Set(summaries.map((item) => item.counterpartyUserId).filter((id): id is string => Boolean(id)))];
  const phones = [...new Set(summaries.map((item) => item.phone).filter((phone): phone is string => Boolean(phone)))];
  const [houses, states, profilesResult, contactsResult] = await Promise.all([
    loadWorkspaceHouseLabels(db, owners, { throwOnError: true }),
    loadSmsProjectionViewStates(db, { viewerUserId: viewerId, conversationIds: ids }),
    userIds.length ? db.from("profiles").select("id,email,full_name").in("id", userIds) : Promise.resolve({ data: [], error: null }),
    phones.length ? db.from("manager_sms_contacts").select("manager_user_id,phone_e164,counterparty_role,display_name,contact_email")
      .in("manager_user_id", owners).in("phone_e164", phones) : Promise.resolve({ data: [], error: null }),
  ]);
  if (profilesResult.error || contactsResult.error) throw new Error("Could not load SMS contact labels.");
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [String(profile.id), profile]));
  const contacts = new Map((contactsResult.data ?? []).map((contact) => [
    managerSmsContactKey(String(contact.manager_user_id), String(contact.phone_e164), contact.counterparty_role), contact,
  ]));
  const emails = [...new Set(summaries.flatMap((summary) => {
    const profile = summary.counterpartyUserId ? profiles.get(summary.counterpartyUserId) : null;
    const email = String(profile?.email ?? summary.metadata.email ?? "").trim().toLowerCase();
    return email.includes("@") ? [email] : [];
  }))];
  const { data: applications, error: applicationsError } = emails.length
    ? await db.from("manager_application_records").select("manager_user_id,resident_email,row_data,updated_at")
      .in("manager_user_id", owners).in("resident_email", emails).order("updated_at", { ascending: false }).limit(1000)
    : { data: [], error: null };
  if (applicationsError) throw new Error("Could not load SMS residency labels.");
  const applicationsByOwnerEmail = new Map<string, { property: string; name: string }>();
  for (const application of applications ?? []) {
    const row = application.row_data as { bucket?: string; stage?: string; property?: string; name?: string } | null;
    if (!row || !["approved", "pending"].includes(String(row.bucket)) || String(row.stage ?? "").toLowerCase() === "in progress") continue;
    const key = `${application.manager_user_id}\0${String(application.resident_email).toLowerCase()}`;
    if (!applicationsByOwnerEmail.has(key)) applicationsByOwnerEmail.set(key, { property: String(row.property ?? ""), name: String(row.name ?? "") });
  }
  const directory = new Map<string, { name: string | null; email: string | null; savedName: string | null }>();
  const houseByOwnerAndAlias = new Map<string, string>();
  for (const [id, house] of houses) {
    for (const alias of [house.label.toLowerCase(), ...house.aliases]) {
      const key = `${house.ownerUserId}\0${alias}`;
      if (!houseByOwnerAndAlias.has(key)) houseByOwnerAndAlias.set(key, id);
      else houseByOwnerAndAlias.set(key, "");
    }
  }
  for (const summary of summaries) {
    const profile = summary.counterpartyUserId ? profiles.get(summary.counterpartyUserId) : null;
    const contact = summary.phone ? contacts.get(managerSmsContactKey(summary.ownerManagerUserId, summary.phone, summary.counterpartyRole as Parameters<typeof managerSmsContactKey>[2])) : null;
    const email = String(profile?.email ?? summary.metadata.email ?? contact?.contact_email ?? "").trim().toLowerCase() || null;
    const application = email ? applicationsByOwnerEmail.get(`${summary.ownerManagerUserId}\0${email}`) : null;
    directory.set(summary.id, {
      name: String(profile?.full_name ?? application?.name ?? summary.metadata.name ?? "").trim() || null,
      email,
      savedName: String(contact?.display_name ?? "").trim() || null,
    });
    if ((houseIds.get(summary.id)?.length ?? 0) > 0) continue;
    if (summary.counterpartyRole !== "resident" && summary.counterpartyRole !== "applicant") continue;
    // Residency follows the *current* server directory after a move. A
    // snapshotted property label in an SMS event cannot grant house access.
    const propertyLabel = application?.property.trim().toLowerCase() ?? "";
    if (application?.property) residencyLabels.set(summary.id, application.property);
    const id = houseByOwnerAndAlias.get(`${summary.ownerManagerUserId}\0${propertyLabel}`);
    if (id) houseIds.set(summary.id, [id]);
  }
  return {
    aliases,
    lastSourceIds,
    houseIds,
    houseLabels: new Map([...houses].map(([id, value]) => [id, value.label])),
    archived,
    residencyLabels,
    viewStates: new Map(states.map((state) => [state.conversationId, state])),
    directory,
  };
}

function asResident(summary: SmsProjectionSummary, context: Context): ManagerSmsResidentConversation & { projectionId: string; unread: boolean; stateVersion: number } {
  const memberKeys = context.aliases.get(summary.id) ?? [];
  const linePhone = summary.workLinePhone || null;
  const state = context.viewStates.get(summary.id);
  const unread = Boolean(summary.lastInboundAt && summary.lastInboundEventId && (
    !state?.readThroughAt ||
    (summary.lastInboundAt > state.readThroughAt ||
      (summary.lastInboundAt === state.readThroughAt && summary.lastInboundEventId > (state.readThroughEventId ?? "")))
  ));
  return {
    projectionId: summary.id,
    workLineId: summary.workLineId,
    unread,
    stateVersion: state?.version ?? 0,
    sendDisabled: summary.metadata.sendDisabled === true,
    residentUserId: summary.counterpartyUserId,
    residentEmail: context.directory.get(summary.id)?.email ?? null,
    name: context.directory.get(summary.id)?.name ?? context.directory.get(summary.id)?.savedName ?? summary.phone ?? "Unknown contact",
    savedContactName: context.directory.get(summary.id)?.savedName ?? null,
    directoryName: context.directory.get(summary.id)?.name ?? null,
    phone: summary.phone,
    propertyLabel: context.residencyLabels.get(summary.id) ?? null,
    tenancyStatus: summary.counterpartyRole === "resident" ? "resident" : "applicant",
    counterpartyRole: summary.counterpartyRole,
    conversationKey: summary.legacyKey ?? memberKeys[0],
    memberKeys,
    ownerManagerUserId: summary.ownerManagerUserId,
    houses: (context.houseIds.get(summary.id) ?? []).map((propertyId) => ({ propertyId, label: context.houseLabels.get(propertyId) ?? propertyId, source: "manual" as const })),
    archived: state?.isArchived ?? context.archived.has(summary.id),
    messages: previewTurn(summary, linePhone, summary.lastEventId ? context.lastSourceIds.get(summary.lastEventId) ?? null : null),
  };
}

/** Check replacement visibility for a bounded set of exact notice targets.
 * Reuses the same house, residency, line and workspace resolver as the list
 * and detail readers, with one scope/context load for the entire batch. */
export async function visibleManagerSmsProjectionIds(
  db: SupabaseClient,
  viewerId: string,
  summaries: SmsProjectionSummary[],
): Promise<Set<string>> {
  if (summaries.length === 0) return new Set();
  if (summaries.length > 40) throw new Error("SMS notice visibility batch exceeds limit.");
  const scope = await resolveCommunicationScope(db, viewerId, "read");
  const candidates = summaries.filter((summary) => scope.ownerIds.includes(summary.ownerManagerUserId));
  if (!candidates.length) return new Set();
  const context = await loadPageContext(db, viewerId, candidates);
  return new Set(candidates.filter((summary) => conversationVisible(scope, {
    ownerId: summary.ownerManagerUserId,
    houseIds: context.houseIds.get(summary.id) ?? [],
    lines: summary.workLinePhone ? [summary.workLinePhone] : [],
  })).map((summary) => summary.id));
}

/** Read summary pages without touching transport message tables or full histories. */
export async function fetchManagerSmsProjectionPage(db: SupabaseClient, viewerId: string, before: SmsProjectionCursor | null) {
  const scope = await resolveCommunicationScope(db, viewerId, "read");
  const visible: (ManagerSmsResidentConversation & { projectionId: string; unread: boolean; stateVersion: number })[] = [];
  let cursor = before;
  let hasMore = false;
  // Each request inspects at most ten indexed summary pages. An owner with
  // many hidden threads can yield an empty page with a continuation cursor;
  // the client must not treat that as the end of history.
  for (let scan = 0; scan < 10; scan += 1) {
    const pages = await Promise.all(scope.ownerIds.map((ownerManagerUserId) =>
      listSmsProjectionConversations(db, { ownerManagerUserId, before: cursor ?? undefined, limit: PAGE_SIZE }),
    ));
    const candidates = pages.flatMap((page) => page.items).sort(tupleBefore).slice(0, PAGE_SIZE);
    if (!candidates.length) { hasMore = false; break; }
    const context = await loadPageContext(db, viewerId, candidates);
    let processed = 0;
    for (const summary of candidates) {
      processed += 1;
      const houseIds = context.houseIds.get(summary.id) ?? [];
      const line = summary.workLinePhone;
      if (conversationVisible(scope, { ownerId: summary.ownerManagerUserId, houseIds, lines: line ? [line] : [] })) {
        visible.push(asResident(summary, context));
      }
      cursor = { occurredAt: summary.lastEventAt!, id: summary.id };
      if (visible.length === PAGE_SIZE) break;
    }
    hasMore = processed < candidates.length || candidates.length === PAGE_SIZE || pages.some((page) => page.nextCursor !== null);
    if (visible.length >= PAGE_SIZE || !hasMore) break;
  }
  const { data: profile } = await db.from("profiles").select("phone,phone_verified_at,sms_forward_inbound").eq("id", viewerId).maybeSingle();
  const workNumber = await resolveViewerWorkNumber(db, viewerId).then((row) => row?.phoneNumber ?? null);
  return {
    workNumber,
    personalPhone: String(profile?.phone ?? "").trim() || null,
    phoneVerified: Boolean(profile?.phone_verified_at),
    forwardInbound: profile?.sms_forward_inbound !== false,
    smsConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    residents: visible.slice(0, PAGE_SIZE),
    nextCursor: hasMore ? encodeCursor(cursor) : null,
  };
}

/** Authorize a selected summary again before returning its independent turn page. */
export async function fetchManagerSmsProjectionDetail(db: SupabaseClient, viewerId: string, conversationId: string, before: SmsProjectionCursor | null, level: "read" | "edit" | "delete" = "read", redirected = false) {
  const { data: row, error } = await db.from("sms_projection_conversations")
    .select("id,owner_manager_user_id,counterparty_role,work_line_id,work_line_phone,identity_key,identity_kind,counterparty_user_id,counterparty_phone,legacy_conversation_key,last_body,last_direction,last_event_at,last_event_id,last_inbound_at,last_inbound_event_id,event_count,metadata,merged_into_id")
    .eq("id", conversationId).maybeSingle();
  if (error || !row) return null;
  if (row.merged_into_id) {
    if (redirected || row.merged_into_id === conversationId) return null;
    return fetchManagerSmsProjectionDetail(db, viewerId, String(row.merged_into_id), before, level, true);
  }
  const scope = await resolveCommunicationScope(db, viewerId, level);
  if (!scope.ownerIds.includes(String(row.owner_manager_user_id))) return null;
  const summary: SmsProjectionSummary = {
    id: String(row.id), ownerManagerUserId: String(row.owner_manager_user_id), counterpartyRole: row.counterparty_role,
    workLineId: row.work_line_id, workLinePhone: row.work_line_phone, identityKey: row.identity_key, identityKind: row.identity_kind,
    counterpartyUserId: row.counterparty_user_id, phone: row.counterparty_phone, legacyKey: row.legacy_conversation_key,
    lastBody: row.last_body, lastDirection: row.last_direction, lastEventAt: row.last_event_at, lastEventId: row.last_event_id,
    lastInboundAt: row.last_inbound_at, lastInboundEventId: row.last_inbound_event_id,
    count: Number(row.event_count), metadata: row.metadata ?? {},
  };
  const context = await loadPageContext(db, viewerId, [summary]);
  const line = summary.workLinePhone;
  if (!conversationVisible(scope, { ownerId: summary.ownerManagerUserId, houseIds: context.houseIds.get(summary.id) ?? [], lines: line ? [line] : [] })) return null;
  const page = await getSmsProjectionTurns(db, { ownerManagerUserId: summary.ownerManagerUserId, conversationId, before: before ?? undefined, limit: 50 });
  const outboundSids = [...new Set(page.turns.filter((turn) => turn.direction === "outbound" && isTwilioMessageSid(turn.sourceEventId)).map((turn) => turn.sourceEventId))];
  const { data: outboxRows, error: outboxError } = outboundSids.length
    ? await db.from("sms_outbox").select("provider_message_sid,actor_user_id").eq("manager_user_id", summary.ownerManagerUserId).in("provider_message_sid", outboundSids)
    : { data: [], error: null };
  if (outboxError) throw new Error("Could not load SMS sender labels.");
  const actorIds = [...new Set((outboxRows ?? []).map((row) => String(row.actor_user_id ?? "")).filter(Boolean))];
  const { data: actorProfiles, error: actorError } = actorIds.length
    ? await db.from("profiles").select("id,full_name").in("id", actorIds)
    : { data: [], error: null };
  if (actorError) throw new Error("Could not load SMS sender labels.");
  const actorNames = new Map((actorProfiles ?? []).map((actor) => [String(actor.id), String(actor.full_name ?? "").trim()]));
  const actorBySid = new Map((outboxRows ?? []).map((outbox) => [String(outbox.provider_message_sid), String(outbox.actor_user_id ?? "")]));
  return {
    messages: page.turns.reverse().map((turn) => {
      const message = mapTurn(turn);
      const actorId = actorBySid.get(turn.sourceEventId);
      return actorId && actorId !== viewerId ? { ...message, sentBy: { userId: actorId, name: actorNames.get(actorId) || "Teammate" } } : message;
    }),
    nextCursor: encodeCursor(page.nextCursor),
    stateVersion: context.viewStates.get(summary.id)?.version ?? 0,
    unread: asResident(summary, context).unread,
    archived: asResident(summary, context).archived === true,
    lastEventAt: summary.lastEventAt,
    lastEventId: summary.lastEventId,
    resident: asResident(summary, context),
  };
}

/** Resolve a legacy pointer only when it has one authorized line/role target. */
export async function resolveManagerSmsProjectionSelection(db: SupabaseClient, viewerId: string, idOrAlias: string): Promise<string | "ambiguous" | null> {
  if (/^[0-9a-f-]{36}$/i.test(idOrAlias)) return idOrAlias;
  if (!idOrAlias || idOrAlias.length > 240) return null;
  const { data, error } = await db.from("sms_projection_aliases")
    .select("conversation_id").eq("alias_value", idOrAlias).limit(21);
  if (error || !data || data.length > 20) return "ambiguous";
  const visible = new Set<string>();
  for (const alias of data) {
    const detail = await fetchManagerSmsProjectionDetail(db, viewerId, String(alias.conversation_id), null);
    if (detail?.resident.projectionId) visible.add(detail.resident.projectionId);
    if (visible.size > 1) return "ambiguous";
  }
  return [...visible][0] ?? null;
}
