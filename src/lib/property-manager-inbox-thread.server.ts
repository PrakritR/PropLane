/**
 * One Communication thread per (resident/prospect email, manager, property).
 */
import { formatPacificDateTime } from "@/lib/pacific-time";
import { createHash } from "node:crypto";

const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function fnv1aHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function propertyManagerConversationThreadId(input: {
  residentEmail: string;
  managerUserId: string;
  propertyId: string;
}): string {
  const key = [
    input.residentEmail.trim().toLowerCase(),
    input.managerUserId.trim(),
    input.propertyId.trim(),
  ].join("\0");
  return `property_mgr_${fnv1aHash(key)}`;
}

type PropertyManagerThreadSide = "resident" | "manager";

/**
 * Resident ids keep the established value used by tour links. Manager rows
 * need their own id because portal_inbox_thread_records.id is globally unique,
 * not unique within a portal scope.
 */
export function propertyManagerConversationSideThreadId(
  input: Parameters<typeof propertyManagerConversationThreadId>[0],
  side: PropertyManagerThreadSide,
): string {
  const base = propertyManagerConversationThreadId(input);
  return side === "resident" ? base : `${base}:manager`;
}

type StoredThreadRow = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string | null;
  row_data: Record<string, unknown> | null;
};

function normalizedEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function compatiblePropertyManagerThread(
  row: StoredThreadRow,
  input: {
    side: PropertyManagerThreadSide;
    residentEmail: string;
    residentUserId: string | null;
    managerUserId: string;
    managerEmail: string;
    propertyId: string;
    requireCounterpartyEmail?: boolean;
    allowProvenIdentity?: boolean;
  },
): boolean {
  const expectedScope = input.side === "resident" ? RESIDENT_INBOX_SCOPE : MANAGER_INBOX_SCOPE;
  if (row.scope !== expectedScope || row.thread_type !== "portal_message") return false;
  const rowData = asObject(row.row_data) ?? {};
  if (String(rowData.folder ?? "") === "trash") return false;
  const expectedCounterparty = input.side === "resident" ? input.managerEmail : input.residentEmail;
  const storedEmail = normalizedEmail(rowData.email);
  const emailMatches = Boolean(expectedCounterparty) && storedEmail === normalizedEmail(expectedCounterparty);
  const identityMatches = Boolean(input.allowProvenIdentity)
    && !storedEmail
    && String(rowData.managerUserId ?? "").trim() === input.managerUserId
    && String(rowData.propertyId ?? "").trim() === input.propertyId
    && (input.side !== "manager" || normalizedEmail(row.participant_email) === normalizedEmail(input.residentEmail));
  if (input.requireCounterpartyEmail ? !emailMatches : !emailMatches && !identityMatches) return false;
  if (input.side === "manager") {
    if (row.owner_user_id !== input.managerUserId) return false;
  } else if (input.residentUserId) {
    if (row.owner_user_id !== input.residentUserId) return false;
  } else {
    if (row.owner_user_id !== null) return false;
    if (normalizedEmail(row.participant_email) !== normalizedEmail(input.residentEmail)) return false;
  }
  const storedManagerId = String(rowData.managerUserId ?? "").trim();
  const storedPropertyId = String(rowData.propertyId ?? "").trim();
  if (storedManagerId && storedManagerId !== input.managerUserId) return false;
  if (storedPropertyId && storedPropertyId !== input.propertyId) return false;
  const role = String(rowData.counterpartyRole ?? "").trim().toLowerCase();
  if (input.side === "resident" && role && !["manager", "owner", "pro", "admin"].includes(role)) return false;
  if (input.side === "manager" && role && !["resident", "applicant", "prospect"].includes(role)) return false;
  return true;
}

async function resolvePropertyManagerThread(
  db: Db,
  input: {
    side: PropertyManagerThreadSide;
    residentEmail: string;
    residentUserId: string | null;
    managerUserId: string;
    managerEmail: string;
    propertyId: string;
  },
): Promise<{ id: string; existing: StoredThreadRow | null }> {
  const stableId = propertyManagerConversationSideThreadId(
    {
      residentEmail: input.residentEmail,
      managerUserId: input.managerUserId,
      propertyId: input.propertyId,
    },
    input.side,
  );
  const columns = "id, scope, owner_user_id, participant_email, thread_type, row_data";
  const sideId = `${propertyManagerConversationThreadId(input)}:${input.side}`;
  const fallbackId = sideId === stableId ? `${sideId}:v2` : sideId;
  let vacantId: string | null = null;
  for (const candidateId of [...new Set([stableId, fallbackId])]) {
    const { data: exact, error: exactError } = await db
      .from("portal_inbox_thread_records")
      .select(columns)
      .eq("id", candidateId)
      .maybeSingle();
    if (exactError) throw new Error("Could not verify the canonical property manager thread.");
    if (!exact) {
      vacantId ??= candidateId;
      continue;
    }
    if (compatiblePropertyManagerThread(exact as StoredThreadRow, { ...input, allowProvenIdentity: true })) {
      return { id: candidateId, existing: exact as StoredThreadRow };
    }
  }

  const expectedCounterparty = input.side === "resident" ? normalizedEmail(input.managerEmail) : normalizedEmail(input.residentEmail);
  if (!expectedCounterparty) {
    if (vacantId) return { id: vacantId, existing: null };
    throw new Error("Cannot resolve a compatible property manager thread without a verified counterparty email.");
  }
  const expectedScope = input.side === "resident" ? RESIDENT_INBOX_SCOPE : MANAGER_INBOX_SCOPE;
  let query = db
    .from("portal_inbox_thread_records")
    .select(columns)
    .eq("scope", expectedScope)
    .eq("thread_type", "portal_message")
    .eq("row_data->>email", expectedCounterparty);
  query = input.side === "manager" || input.residentUserId
    ? query.eq("owner_user_id", input.side === "manager" ? input.managerUserId : input.residentUserId)
    : query.eq("participant_email", normalizedEmail(input.residentEmail));
  const { data: candidates, error: candidatesError } = await query.order("updated_at", { ascending: false }).limit(100);
  if (candidatesError) throw new Error("Could not search compatible property manager threads.");
  const compatible = ((candidates ?? []) as StoredThreadRow[])
    .filter((row) => compatiblePropertyManagerThread(row, { ...input, requireCounterpartyEmail: true }))
    .sort((left, right) => {
      const leftExact = String(left.row_data?.propertyId ?? "") === input.propertyId ? 1 : 0;
      const rightExact = String(right.row_data?.propertyId ?? "") === input.propertyId ? 1 : 0;
      return rightExact - leftExact;
    })[0];
  if (compatible) return { id: compatible.id, existing: compatible };
  if (vacantId) return { id: vacantId, existing: null };
  throw new Error("Both canonical property manager thread ids are occupied by incompatible records.");
}

export function propertyManagerThreadLabel(propertyTitle: string): string {
  const title = propertyTitle.trim() || "Property";
  return `Property manager (${title})`;
}

type ThreadMessage = {
  id: string;
  from: string;
  body: string;
  at: string;
  outbound?: boolean;
  subject?: string;
};

function appendThreadMessages(
  rowData: Record<string, unknown>,
  turns: ThreadMessage[],
): ThreadMessage[] {
  const messages = Array.isArray(rowData.messages)
    ? [...(rowData.messages as ThreadMessage[])]
    : [];
  messages.push(...turns);
  return messages;
}

function recordedMessage(rowData: Record<string, unknown>, messageId: string, subject: string, body: string): boolean {
  const rootMatches = rowData.rootMessageId === messageId;
  const message = Array.isArray(rowData.messages)
    ? (rowData.messages as ThreadMessage[]).find((turn) => turn.id === messageId)
    : undefined;
  if (!rootMatches && !message) return false;
  const recordedBody = message?.body ?? String(rowData.body ?? "");
  const recordedSubject = message?.subject ?? String(rowData.rootMessageSubject ?? rowData.subject ?? "");
  if (recordedBody !== body || recordedSubject !== subject) {
    throw new Error("This send id was already used for different message content.");
  }
  return true;
}

export function propertyManagerSendMessageIds(
  senderUserId: string,
  sendId: string,
  target: { managerUserId: string; propertyId: string; recipientEmail: string },
): {
  resident: string;
  manager: string;
} {
  // The browser operation id only identifies a retry once the server has bound
  // it to the authorized manager/property/email destination. Without this,
  // reusing a UUID for a different target can suppress or cross-link a send.
  const targetIdentity = [
    target.managerUserId.trim(),
    target.propertyId.trim(),
    target.recipientEmail.trim().toLowerCase(),
  ].join("\0");
  const operation = createHash("sha256")
    .update(`${senderUserId.trim()}\0${sendId.trim().toLowerCase()}\0${targetIdentity}`)
    .digest("hex")
    .slice(0, 32);
  return {
    resident: `property-chat:${operation}:resident`,
    manager: `property-chat:${operation}:manager`,
  };
}

/** Resident-side thread for messages about one listing with one manager. */
export async function appendResidentPropertyManagerInboxMessage(
  db: Db,
  input: {
    participantEmail: string;
    managerUserId: string;
    propertyId: string;
    propertyTitle: string;
    subject: string;
    body: string;
    residentMessage?: string;
    residentName?: string;
    counterpartyEmail?: string;
    fromName?: string;
  },
): Promise<void> {
  const guestEmail = input.participantEmail.trim().toLowerCase();
  if (!guestEmail.includes("@")) return;

  const { data: guestProfile } = await db.from("profiles").select("id").eq("email", guestEmail).maybeSingle();
  const ownerUserId = (guestProfile?.id as string | null) ?? null;
  const target = await resolvePropertyManagerThread(db, {
    side: "resident",
    residentEmail: guestEmail,
    residentUserId: ownerUserId,
    managerUserId: input.managerUserId,
    managerEmail: input.counterpartyEmail?.trim().toLowerCase() || "",
    propertyId: input.propertyId,
  });
  const threadId = target.id;
  const when = formatPacificDateTime(new Date());
  const displayFrom = propertyManagerThreadLabel(input.propertyTitle);
  const counterpartyEmail = input.counterpartyEmail?.trim().toLowerCase() || "";
  const ackFrom = input.fromName ?? "PropLane";
  const residentMessage = input.residentMessage?.trim() ?? "";
  const previewSource = residentMessage || input.body;

  const existing = target.existing;

  if (existing?.row_data) {
    const rowData = asObject(existing.row_data) ?? {};
    const newTurns: ThreadMessage[] = residentMessage
      ? [
          {
            id: `out-${Date.now().toString(36)}`,
            from: input.residentName?.trim() || "You",
            body: residentMessage,
            at: when,
            outbound: true,
          },
          {
            id: `ack-${Date.now().toString(36)}`,
            from: ackFrom,
            body: input.body,
            at: when,
            outbound: false,
          },
        ]
      : [
          {
            id: `msg-${Date.now().toString(36)}`,
            from: ackFrom,
            body: input.body,
            at: when,
            outbound: false,
          },
        ];

    const { error: updateError } = await db.from("portal_inbox_thread_records").upsert(
      {
        id: threadId,
        scope: RESIDENT_INBOX_SCOPE,
        owner_user_id: ownerUserId ?? existing.owner_user_id ?? null,
        participant_email: guestEmail,
        thread_type: "portal_message",
        row_data: {
          ...rowData,
          from: displayFrom,
          email: counterpartyEmail || String(rowData.email ?? ""),
          subject: input.subject.trim() || String(rowData.subject ?? ""),
          preview: previewSource.slice(0, 100).replace(/\n/g, " "),
          time: when,
          unread: true,
          propertyId: input.propertyId,
          managerUserId: input.managerUserId,
          counterpartyRole: "manager",
          propertyTitle: input.propertyTitle,
          messages: appendThreadMessages(rowData, newTurns),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (updateError) throw new Error("Could not update the resident property manager thread.");
    return;
  }

  const messages: ThreadMessage[] = residentMessage
    ? [
        {
          id: `ack-${Date.now().toString(36)}`,
          from: ackFrom,
          body: input.body,
          at: when,
          outbound: false,
        },
      ]
    : [];

  const { error: insertError } = await db.from("portal_inbox_thread_records").insert(
    {
      id: threadId,
      scope: RESIDENT_INBOX_SCOPE,
      owner_user_id: ownerUserId,
      participant_email: guestEmail,
      thread_type: "portal_message",
      row_data: {
        id: threadId,
        folder: "inbox",
        from: displayFrom,
        email: counterpartyEmail,
        subject: input.subject,
        preview: previewSource.slice(0, 100).replace(/\n/g, " "),
        body: residentMessage || input.body,
        time: when,
        unread: true,
        scope: RESIDENT_INBOX_SCOPE,
        propertyId: input.propertyId,
        managerUserId: input.managerUserId,
        counterpartyRole: "manager",
        propertyTitle: input.propertyTitle,
        ...(residentMessage ? { rootOutbound: true } : {}),
        ...(messages.length ? { messages } : {}),
      },
      updated_at: new Date().toISOString(),
    },
  );
  if (insertError) throw new Error("Could not create the resident property manager thread.");
}

/**
 * Resident-initiated chat in the property-scoped thread (no PropLane ack turn).
 * Writes the resident outbound copy and the manager inbound copy on the same
 * stable thread id used by tour and listing messages.
 */
export async function deliverResidentPropertyManagerChatMessage(
  db: Db,
  input: {
    residentEmail: string;
    residentUserId: string | null;
    residentName: string;
    managerUserId: string;
    managerEmail: string;
    propertyId: string;
    propertyTitle: string;
    subject: string;
    message: string;
    messageIds?: { resident: string; manager: string };
  },
): Promise<{ threadId: string }> {
  const residentEmail = input.residentEmail.trim().toLowerCase();
  const managerEmail = input.managerEmail.trim().toLowerCase();
  const message = input.message.trim();
  const subject = input.subject.trim();
  if (!residentEmail.includes("@") || !managerEmail.includes("@") || !message || !subject) {
    throw new Error("resident email, manager email, subject, and message are required.");
  }

  const residentTarget = await resolvePropertyManagerThread(db, {
    side: "resident",
    residentEmail,
    residentUserId: input.residentUserId,
    managerUserId: input.managerUserId,
    managerEmail,
    propertyId: input.propertyId,
  });
  const threadId = residentTarget.id;
  const when = formatPacificDateTime(new Date());
  const displayFrom = propertyManagerThreadLabel(input.propertyTitle);
  const residentName = input.residentName.trim() || "You";
  const preview = message.slice(0, 100).replace(/\n/g, " ");

  const outboundTurn: ThreadMessage = {
    id: `out-${Date.now().toString(36)}`,
    from: residentName,
    body: message,
    at: when,
    outbound: true,
  };

  const residentExisting = residentTarget.existing;

  if (residentExisting?.row_data) {
    const rowData = asObject(residentExisting.row_data) ?? {};
    if (input.messageIds && recordedMessage(rowData, input.messageIds.resident, subject, message)) {
      // The manager-side retry still runs below.
    } else {
    const { error: updateError } = await db.from("portal_inbox_thread_records").upsert(
      {
        id: threadId,
        scope: RESIDENT_INBOX_SCOPE,
        owner_user_id:
          input.residentUserId ??
          residentExisting.owner_user_id ??
          null,
        participant_email: residentEmail,
        thread_type: "portal_message",
        row_data: {
          ...rowData,
          from: displayFrom,
          email: managerEmail || String(rowData.email ?? ""),
          subject: subject || String(rowData.subject ?? ""),
          preview,
          time: when,
          unread: false,
          propertyId: input.propertyId,
          managerUserId: input.managerUserId,
          counterpartyRole: "manager",
          propertyTitle: input.propertyTitle,
          messages: appendThreadMessages(rowData, [{ ...outboundTurn, id: input.messageIds?.resident ?? outboundTurn.id, subject }]),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (updateError) throw new Error("Could not update the resident property manager thread.");
    }
  } else {
    const { error: insertError } = await db.from("portal_inbox_thread_records").insert(
      {
        id: threadId,
        scope: RESIDENT_INBOX_SCOPE,
        owner_user_id: input.residentUserId,
        participant_email: residentEmail,
        thread_type: "portal_message",
        row_data: {
          id: threadId,
          folder: "inbox",
          from: displayFrom,
          email: managerEmail,
          subject,
          preview,
          body: message,
          ...(input.messageIds ? { rootMessageId: input.messageIds.resident } : {}),
          ...(input.messageIds ? { rootMessageSubject: subject } : {}),
          time: when,
          unread: false,
          scope: RESIDENT_INBOX_SCOPE,
          propertyId: input.propertyId,
          managerUserId: input.managerUserId,
          counterpartyRole: "manager",
          propertyTitle: input.propertyTitle,
          rootOutbound: true,
        },
        updated_at: new Date().toISOString(),
      },
    );
    if (insertError) throw new Error("Could not create the resident property manager thread.");
  }

  await appendManagerPropertyLeadInboxMessage(db, input.managerUserId, {
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    prospectName: residentName,
    prospectEmail: residentEmail,
    topic: subject,
    subject,
    body: message,
    messageId: input.messageIds?.manager,
  });

  return { threadId };
}

/** Manager-side thread for the same property conversation. */
export async function appendManagerPropertyLeadInboxMessage(
  db: Db,
  managerUserId: string,
  input: {
    propertyId: string;
    propertyTitle: string;
    prospectName: string;
    prospectEmail: string;
    topic: string;
    subject: string;
    body: string;
    messageId?: string;
  },
): Promise<void> {
  const prospectEmail = input.prospectEmail.trim().toLowerCase();
  if (!prospectEmail.includes("@")) return;

  const target = await resolvePropertyManagerThread(db, {
    side: "manager",
    residentEmail: prospectEmail,
    residentUserId: null,
    managerUserId,
    managerEmail: "",
    propertyId: input.propertyId,
  });
  const threadId = target.id;
  const when = formatPacificDateTime(new Date());
  const propertyLabel = input.propertyTitle.trim() || input.propertyId;
  const threadSubject = `${propertyLabel} — ${input.topic.trim() || input.subject}`;

  const existing = target.existing;

  const inboundTurn: ThreadMessage = {
    id: `lead-${Date.now().toString(36)}`,
    from: input.prospectName.trim() || prospectEmail,
    body: input.body,
    at: when,
    outbound: false,
  };

  if (existing?.row_data) {
    const rowData = asObject(existing.row_data) ?? {};
    if (input.messageId && recordedMessage(rowData, input.messageId, threadSubject, input.body)) return;
    const { error: updateError } = await db.from("portal_inbox_thread_records").upsert(
      {
        id: threadId,
        scope: MANAGER_INBOX_SCOPE,
        owner_user_id: managerUserId,
        participant_email: prospectEmail,
        thread_type: "portal_message",
        row_data: {
          ...rowData,
          from: input.prospectName.trim() || prospectEmail,
          email: prospectEmail,
          subject: threadSubject,
          preview: input.body.slice(0, 100).replace(/\n/g, " "),
          time: when,
          unread: true,
          propertyId: input.propertyId,
          managerUserId,
          counterpartyRole: "resident",
          propertyTitle: propertyLabel,
          messages: appendThreadMessages(rowData, [{ ...inboundTurn, id: input.messageId ?? inboundTurn.id, subject: threadSubject }]),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (updateError) throw new Error("Could not update the manager property thread.");
    return;
  }

  const { error: insertError } = await db.from("portal_inbox_thread_records").insert(
    {
      id: threadId,
      scope: MANAGER_INBOX_SCOPE,
      owner_user_id: managerUserId,
      participant_email: prospectEmail,
      thread_type: "portal_message",
      row_data: {
        id: threadId,
        folder: "inbox",
        from: input.prospectName.trim() || prospectEmail,
        email: prospectEmail,
        subject: threadSubject,
        preview: input.body.slice(0, 100).replace(/\n/g, " "),
        body: input.body,
        ...(input.messageId ? { rootMessageId: input.messageId } : {}),
        ...(input.messageId ? { rootMessageSubject: threadSubject } : {}),
        time: when,
        unread: true,
        scope: MANAGER_INBOX_SCOPE,
        propertyId: input.propertyId,
        managerUserId,
        counterpartyRole: "resident",
        propertyTitle: propertyLabel,
      },
      updated_at: new Date().toISOString(),
    },
  );
  if (insertError) throw new Error("Could not create the manager property thread.");
}
