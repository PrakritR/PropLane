import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";
import {
  PERSONAL_WORKSPACE_ID,
  deriveConversationKey,
  workspaceKey,
  type AccountCandidate,
  type ConversationFlag,
  type DerivedConversationKey,
} from "@/lib/communication/conversation-key";

/**
 * THE conversation-key resolver. Every writer that stores a person-thread asks
 * here which workspace the conversation lives in and which key it is stored
 * under (account -> verified phone -> email; see `conversation-key.ts`).
 *
 * Every lookup degrades to "no answer": a failed read returns `null`, and a
 * writer with no ref falls back to the legacy per-email thread behaviour. The
 * resolver never invents an identity and never merges on a guess - an
 * ambiguous phone comes back flagged, standing alone.
 */

const MANAGER_SCOPE_HINTS = ["manager", "pro", "owner"];

export type ConversationHints = {
  /** The house the message is about; picks the workspace. */
  propertyId?: string | null;
  /** The workspace the writer already knows (a work line's workspace). Verified against the manager. */
  workspaceId?: string | null;
  /** The counterparty's phone (an SMS notice), E.164 or raw. */
  otherPartyPhone?: string | null;
  /** The counterparty's account id, when the writer holds it. */
  otherPartyUserId?: string | null;
  /** The manager on the other end of a resident / vendor row, when the writer holds it. */
  managerUserId?: string | null;
};

export type ConversationSideInput = {
  scope: string;
  ownerUserId: string | null;
  participantEmail: string | null;
  otherPartyEmail: string;
};

export type ConversationRef = {
  workspaceId: string;
  /** Strongest key. */
  key: string;
  /** Every key this person may already be stored under, strongest first. */
  keys: string[];
  flagged: ConversationFlag | null;
};

export type WorkspaceContext = {
  workspaceId: string;
  workspaceOwnerId: string;
  isDefault: boolean;
};

type Db = SupabaseClient;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isManagerInboxScope(scope: string | null | undefined): boolean {
  const value = clean(scope).toLowerCase();
  if (!value) return false;
  if (value === "admin") return false;
  return MANAGER_SCOPE_HINTS.some((hint) => value === hint) || value.includes("inbox_manager");
}

export function isAdminInboxScope(scope: string | null | undefined): boolean {
  return clean(scope).toLowerCase() === "admin";
}

/** May `managerUserId` act inside a workspace owned by `workspaceOwnerId`? Owner, or an accepted account link. */
async function managerMayUseWorkspace(db: Db, managerUserId: string, workspaceOwnerId: string, workspaceId: string): Promise<boolean> {
  if (managerUserId === workspaceOwnerId) return true;
  const { data, error } = await db
    .from("account_link_invites")
    .select("id")
    .eq("invitee_user_id", managerUserId)
    .eq("inviter_user_id", workspaceOwnerId)
    .eq("status", "accepted")
    .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
    .limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * The workspace a manager's conversation lives in: the named workspace, else
 * the house's workspace, else the manager's default workspace, else the single
 * workspace they were invited into. Read-only (it never provisions a
 * workspace) and `null` when none can be named - the caller then keeps the
 * legacy thread.
 */
export async function resolveWorkspaceContext(
  db: Db,
  managerUserId: string,
  hints: Pick<ConversationHints, "propertyId" | "workspaceId"> = {},
): Promise<WorkspaceContext | null> {
  const manager = clean(managerUserId);
  if (!manager) return null;
  try {
    const named = clean(hints.workspaceId);
    if (named) {
      const { data } = await db.from("portal_workspaces").select("id, owner_user_id, is_default").eq("id", named).maybeSingle();
      if (!data) return null;
      const owner = clean(data.owner_user_id);
      if (!(await managerMayUseWorkspace(db, manager, owner, named))) return null;
      return { workspaceId: named, workspaceOwnerId: owner, isDefault: data.is_default === true };
    }

    const propertyId = clean(hints.propertyId);
    if (propertyId) {
      const { data: property } = await db
        .from("manager_property_records")
        .select("manager_user_id, workspace_id")
        .eq("id", propertyId)
        .maybeSingle();
      if (property) {
        const owner = clean(property.manager_user_id);
        let workspaceId = clean(property.workspace_id);
        if (!workspaceId && owner) {
          const { data: fallback } = await db
            .from("portal_workspaces")
            .select("id")
            .eq("owner_user_id", owner)
            .eq("is_default", true)
            .maybeSingle();
          workspaceId = clean(fallback?.id);
        }
        if (workspaceId && owner && (await managerMayUseWorkspace(db, manager, owner, workspaceId))) {
          const { data: ws } = await db.from("portal_workspaces").select("is_default").eq("id", workspaceId).maybeSingle();
          return { workspaceId, workspaceOwnerId: owner, isDefault: ws?.is_default === true };
        }
      }
    }

    const { data: own } = await db
      .from("portal_workspaces")
      .select("id, owner_user_id, is_default")
      .eq("owner_user_id", manager)
      .eq("is_default", true)
      .maybeSingle();
    if (own?.id) return { workspaceId: clean(own.id), workspaceOwnerId: manager, isDefault: true };

    // A co-manager with no workspace of their own: the one workspace they were invited into.
    const { data: links } = await db
      .from("account_link_invites")
      .select("inviter_user_id, workspace_id")
      .eq("invitee_user_id", manager)
      .eq("status", "accepted")
      .not("workspace_id", "is", null);
    const distinct = new Map<string, string>();
    for (const link of links ?? []) {
      const id = clean((link as { workspace_id?: unknown }).workspace_id);
      if (id) distinct.set(id, clean((link as { inviter_user_id?: unknown }).inviter_user_id));
    }
    if (distinct.size === 1) {
      const [[workspaceId, owner]] = [...distinct.entries()] as [[string, string]];
      const { data: ws } = await db.from("portal_workspaces").select("is_default").eq("id", workspaceId).maybeSingle();
      return { workspaceId, workspaceOwnerId: owner, isDefault: ws?.is_default === true };
    }
  } catch {
    return null;
  }
  return null;
}

type ProfileRow = { id?: unknown; email?: unknown; phone?: unknown; phone_verified_at?: unknown };

/** Accounts that could be the person, each marked linked-or-not to the workspace. */
export async function loadAccountCandidates(
  db: Db,
  ctx: WorkspaceContext,
  managerUserId: string,
  who: { accountId?: string | null; email?: string | null; phone?: string | null },
): Promise<AccountCandidate[]> {
  const email = clean(who.email).toLowerCase();
  const phone = normalizeE164(who.phone);
  const accountId = clean(who.accountId);
  const byId = new Map<string, ProfileRow>();
  try {
    const filter = orFilterForIdentity([
      ["id", accountId],
      ["email", email],
    ]);
    if (filter) {
      const { data } = await db.from("profiles").select("id, email, phone, phone_verified_at").or(filter);
      for (const row of (data ?? []) as ProfileRow[]) if (clean(row.id)) byId.set(clean(row.id), row);
    }
    if (phone) {
      const { data } = await db
        .from("profiles")
        .select("id, email, phone, phone_verified_at")
        .in("phone", profilePhoneVariants(phone))
        .not("phone_verified_at", "is", null);
      for (const row of (data ?? []) as ProfileRow[]) if (clean(row.id)) byId.set(clean(row.id), row);
    }
  } catch {
    return [];
  }
  if (byId.size === 0) return [];

  const ids = [...byId.keys()];
  const emails = [...new Set([...byId.values()].map((row) => clean(row.email).toLowerCase()).filter(Boolean))];
  const managers = [...new Set([clean(managerUserId), ctx.workspaceOwnerId].filter(Boolean))];
  const linked = new Set<string>();

  // Which of this workspace's houses exist: a link through a house outside the workspace is not a link.
  let houseIds: Set<string> | null = null;
  const inWorkspace = async (houseId: string): Promise<boolean> => {
    if (!houseId) return ctx.isDefault;
    if (!houseIds) {
      const { data } = await db
        .from("manager_property_records")
        .select("id")
        .eq("manager_user_id", ctx.workspaceOwnerId)
        .eq("workspace_id", ctx.workspaceId);
      houseIds = new Set((data ?? []).map((row) => clean((row as { id?: unknown }).id)).filter(Boolean));
    }
    return houseIds.has(houseId);
  };
  const houseOf = (row: Record<string, unknown>): string => {
    const rd = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
    return clean(row.assigned_property_id ?? rd.assignedPropertyId ?? row.property_id ?? rd.propertyId);
  };
  const idByEmail = new Map<string, string>();
  for (const [id, row] of byId) {
    const e = clean(row.email).toLowerCase();
    if (e) idByEmail.set(e, id);
  }

  try {
    if (emails.length > 0) {
      const { data } = await db
        .from("manager_application_records")
        .select("manager_user_id, resident_email, property_id, assigned_property_id, row_data")
        .in("manager_user_id", managers)
        .in("resident_email", emails);
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = idByEmail.get(clean(row.resident_email).toLowerCase());
        if (id && !linked.has(id) && (await inWorkspace(houseOf(row)))) linked.add(id);
      }
    }
    const leaseReads = [
      emails.length > 0 ? db.from("portal_lease_pipeline_records").select("resident_user_id, resident_email, property_id, row_data").in("manager_user_id", managers).in("resident_email", emails) : null,
      db.from("portal_lease_pipeline_records").select("resident_user_id, resident_email, property_id, row_data").in("manager_user_id", managers).in("resident_user_id", ids),
    ];
    for (const read of leaseReads) {
      if (!read) continue;
      const { data } = await read;
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = ids.includes(clean(row.resident_user_id)) ? clean(row.resident_user_id) : idByEmail.get(clean(row.resident_email).toLowerCase());
        if (id && !linked.has(id) && (await inWorkspace(houseOf(row)))) linked.add(id);
      }
    }
    const { data: vendors } = await db
      .from("manager_vendor_records")
      .select("vendor_user_id")
      .in("manager_user_id", managers)
      .in("vendor_user_id", ids);
    for (const row of (vendors ?? []) as { vendor_user_id?: unknown }[]) {
      const id = clean(row.vendor_user_id);
      if (id) linked.add(id);
    }
  } catch {
    // A failed link read links nobody: the person falls back to phone / email.
  }

  return [...byId.entries()].map(([id, row]) => ({
    id,
    email: clean(row.email) || null,
    phone: clean(row.phone) || null,
    phoneVerified: Boolean(row.phone_verified_at),
    linked: linked.has(id),
  }));
}

/** Account -> verified phone -> email for a person talking with a workspace. */
export async function resolveConversationIdentity(
  db: Db,
  ctx: WorkspaceContext | null,
  managerUserId: string,
  who: { accountId?: string | null; email?: string | null; phone?: string | null },
): Promise<DerivedConversationKey> {
  const accounts = ctx ? await loadAccountCandidates(db, ctx, managerUserId, who) : [];
  return deriveConversationKey({ ...who, accounts });
}

/**
 * Which workspace and which key does this side of a person-thread belong to?
 * `null` = no answer (admin / agent / unresolvable): the writer keeps the
 * legacy behaviour.
 */
export async function resolveConversationRef(
  db: Db,
  side: ConversationSideInput,
  hints: ConversationHints = {},
): Promise<ConversationRef | null> {
  try {
    if (isAdminInboxScope(side.scope)) return null;
    const other = clean(side.otherPartyEmail).toLowerCase();
    if (isManagerInboxScope(side.scope)) {
      const managerId = clean(side.ownerUserId);
      if (!managerId) return null;
      const ctx = await resolveWorkspaceContext(db, managerId, hints);
      if (!ctx) return null;
      const derived = await resolveConversationIdentity(db, ctx, managerId, {
        accountId: hints.otherPartyUserId,
        email: other,
        phone: hints.otherPartyPhone,
      });
      if (!derived.key) return null;
      return { workspaceId: ctx.workspaceId, key: derived.key, keys: derived.keys, flagged: derived.flagged };
    }

    // Resident / vendor / prospect side: the counterparty is a manager workspace.
    let managerId = clean(hints.managerUserId);
    if (!managerId && other) {
      const { data } = await db.from("profiles").select("id").eq("email", other).maybeSingle();
      managerId = clean(data?.id);
    }
    const ctx = managerId ? await resolveWorkspaceContext(db, managerId, hints) : null;
    if (ctx) {
      const key = workspaceKey(ctx.workspaceId);
      return { workspaceId: ctx.workspaceId, key, keys: [key], flagged: null };
    }

    // An outside party (a vendor's own work identity, a stranger's mail): the
    // conversation is the owner's own, keyed by who is on the other end.
    const derived = await resolveConversationIdentity(db, null, "", {
      accountId: hints.otherPartyUserId,
      email: other,
      phone: hints.otherPartyPhone,
    });
    if (!derived.key) return null;
    return { workspaceId: PERSONAL_WORKSPACE_ID, key: derived.key, keys: derived.keys, flagged: derived.flagged };
  } catch {
    return null;
  }
}

/** The ref a RECIPIENT of a send resolves to - what the reply check compares a thread's key against. */
export async function resolveRecipientConversationKeys(
  db: Db,
  input: {
    senderScope: string;
    senderUserId: string;
    recipientEmail: string;
    recipientUserId: string | null;
    hints?: ConversationHints;
  },
): Promise<ConversationRef | null> {
  return resolveConversationRef(
    db,
    {
      scope: input.senderScope,
      ownerUserId: input.senderUserId,
      participantEmail: null,
      otherPartyEmail: input.recipientEmail,
    },
    { ...input.hints, otherPartyUserId: input.recipientUserId },
  );
}

/** The workspace that owns a work line (`manager_sms_numbers.id`), or null. */
export async function workspaceIdForWorkLine(db: Db, workLineId: string | null | undefined): Promise<string | null> {
  const id = clean(workLineId);
  if (!id) return null;
  try {
    const { data } = await db.from("manager_sms_numbers").select("workspace_id").eq("id", id).maybeSingle();
    return clean(data?.workspace_id) || null;
  } catch {
    return null;
  }
}

/**
 * The conversation an SMS counterparty belongs to: a phone (or the account that
 * verified it) in the workspace that owns the work line. `null` = no answer.
 */
export async function resolveSmsConversationRef(
  db: Db,
  args: {
    ownerManagerUserId: string;
    workLineId?: string | null;
    workspaceId?: string | null;
    counterpartyUserId?: string | null;
    counterpartyPhone?: string | null;
  },
): Promise<ConversationRef | null> {
  try {
    const owner = clean(args.ownerManagerUserId);
    if (!owner) return null;
    const workspaceId = clean(args.workspaceId) || (await workspaceIdForWorkLine(db, args.workLineId)) || undefined;
    const ctx = await resolveWorkspaceContext(db, owner, { workspaceId });
    if (!ctx) return null;
    const derived = await resolveConversationIdentity(db, ctx, owner, {
      accountId: args.counterpartyUserId,
      phone: args.counterpartyPhone,
    });
    if (!derived.key) return null;
    return { workspaceId: ctx.workspaceId, key: derived.key, keys: derived.keys, flagged: derived.flagged };
  } catch {
    return null;
  }
}

export type ReplyThread = {
  id: string;
  scope: string;
  ownerUserId: string | null;
  /** `portal_inbox_thread_records.conversation_key`; null on a thread written before keys existed. */
  conversationKey: string | null;
  workspaceId: string | null;
  /** `row_data.email`: the counterparty a legacy thread was stored under. */
  email: string;
};

/** Read the stored key of a thread. Null key / workspace when the column is absent or the read fails. */
export async function loadThreadConversation(
  db: Db,
  threadId: string,
): Promise<{ conversationKey: string | null; workspaceId: string | null }> {
  try {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("conversation_key, workspace_id")
      .eq("id", threadId)
      .maybeSingle();
    if (error || !data) return { conversationKey: null, workspaceId: null };
    return {
      conversationKey: clean((data as { conversation_key?: unknown }).conversation_key) || null,
      workspaceId: clean((data as { workspace_id?: unknown }).workspace_id) || null,
    };
  } catch {
    return { conversationKey: null, workspaceId: null };
  }
}

/**
 * The server-side reply check. A reply written into thread T and delivered to
 * recipient R must be the SAME person: it used to be possible to write the
 * reply into one conversation and the delivered copy into another. Returns the
 * first recipient who is not the thread's person.
 *
 *  - keyed person thread: R must resolve to the thread's key in its workspace
 *  - keyed workspace thread (a resident / vendor talking to a workspace): R must
 *    belong to that workspace
 *  - legacy thread: R's email must be the one it was stored under; a legacy
 *    thread with no counterparty email at all has nothing to compare and is
 *    not blocked
 */
export async function replyRecipientsMatchThread(
  db: Db,
  input: {
    thread: ReplyThread;
    senderUserId: string;
    recipients: readonly { email: string; userId: string | null }[];
    propertyId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; recipientEmail: string }> {
  const { thread } = input;
  const storedEmail = clean(thread.email).toLowerCase();
  if (!thread.conversationKey && storedEmail && input.recipients.length > 0) {
    // A legacy thread names one counterparty; a resident's property reply may
    // also fan out to that manager's co-managers, so one match is enough.
    const matched = input.recipients.some((recipient) => clean(recipient.email).toLowerCase() === storedEmail);
    if (!matched) return { ok: false, recipientEmail: clean(input.recipients[0]!.email).toLowerCase() };
  }
  for (const recipient of input.recipients) {
    const email = clean(recipient.email).toLowerCase();
    if (!thread.conversationKey) continue;

    if (thread.conversationKey.startsWith("ws:")) {
      const workspaceId = thread.conversationKey.slice(3);
      const userId = clean(recipient.userId);
      let belongs = false;
      if (userId && workspaceId) {
        try {
          const { data } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
          const owner = clean(data?.owner_user_id);
          belongs = owner ? await managerMayUseWorkspace(db, userId, owner, workspaceId) : false;
        } catch {
          belongs = false;
        }
      }
      if (!belongs) return { ok: false, recipientEmail: email };
      continue;
    }

    const ref = await resolveConversationRef(
      db,
      {
        scope: thread.scope,
        ownerUserId: thread.ownerUserId ?? input.senderUserId,
        participantEmail: null,
        otherPartyEmail: email,
      },
      {
        propertyId: input.propertyId,
        workspaceId: thread.workspaceId,
        otherPartyUserId: recipient.userId,
        managerUserId: thread.ownerUserId ?? input.senderUserId,
      },
    );
    const sameKey = Boolean(ref) && ref!.keys.includes(thread.conversationKey);
    const sameWorkspace = !thread.workspaceId || ref?.workspaceId === thread.workspaceId;
    if (!sameKey || !sameWorkspace) return { ok: false, recipientEmail: email };
  }
  return { ok: true };
}

/** A house's display title, for labelling the turns of a conversation that spans houses. Best-effort. */
export async function propertyLabelFor(db: Db, propertyId: string | null | undefined): Promise<string | undefined> {
  const id = clean(propertyId);
  if (!id) return undefined;
  try {
    const { data } = await db
      .from("manager_property_records")
      .select("property_data, row_data")
      .eq("id", id)
      .maybeSingle();
    if (!data) return undefined;
    const pd = (data.property_data ?? {}) as { title?: unknown; address?: unknown };
    const rd = (data.row_data ?? {}) as { title?: unknown; address?: unknown };
    return clean(pd.title) || clean(rd.title) || clean(pd.address) || clean(rd.address) || undefined;
  } catch {
    return undefined;
  }
}
