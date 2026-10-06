import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { postgrestFilterValue } from "@/lib/supabase/or-filter";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { loadAccountCandidates, resolveSmsConversationRef, workspaceIdForWorkLine } from "@/lib/communication/conversation-key.server";
import { workspaceKey } from "@/lib/communication/conversation-key";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import {
  decideResidentSmsLink,
  initialsOf,
  isResidentAssistantRow,
  isResidentSmsRole,
  mergeResidentSmsConversations,
  stampCounterparties,
  type ResidentCounterparty,
  type ResidentPhoneState,
  type ResidentSmsConversation,
  type ResidentSmsTurn,
} from "@/lib/communication/resident-conversation";

/**
 * The SERVER side of a resident's Communication: which text conversations are
 * theirs, who each is with, and the stored history stamped for them once they
 * verify a phone. Every function here takes the AUTHENTICATED resident id from
 * the route (never a body) and reads only what `decideResidentSmsLink` says is
 * theirs; a failed read returns "nothing", never a guess.
 */

type Db = SupabaseClient;
type Row = Record<string, unknown>;

/** How many turns of each workspace's text history one list read carries. */
const TURNS_PER_CONVERSATION = 60;
/** A resident with more than this many text conversations is not a resident; stop reading. */
const MAX_CONVERSATIONS = 200;
/** How many distinct addresses one list read will try to name a manager from (one `or` clause each). */
const MAX_NAMED_EMAILS = 50;
/**
 * How many workspaces one link check pass runs at a time. Each costs ~6 reads,
 * so an unbounded pass is how one list read turns into hundreds of concurrent
 * requests from a single invocation.
 */
const LINK_CHECK_CONCURRENCY = 4;
/**
 * A TOTAL ceiling on the checks the legacy email-naming path may spend. Only
 * that path passes it: a `ws:`-keyed conversation is a real conversation of the
 * resident's and always gets its manager named, however many they have.
 */
const MAX_EMAIL_NAMING_LINK_CHECKS = 24;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type ResidentPhoneIdentity = {
  residentId: string;
  /** Verified, valid E.164; null when the profile has none verified. */
  verifiedPhone: string | null;
  /** Every distinct account that verified `verifiedPhone`, the resident included. */
  phoneVerifierIds: string[];
  state: ResidentPhoneState;
};

/**
 * The resident's verified phone and whether anyone else verified it too.
 * `phone_verified_at` is the ONLY thing that makes a phone an identity.
 */
export async function loadResidentPhoneIdentity(db: Db, residentId: string): Promise<ResidentPhoneIdentity> {
  const none = (hasPhone: boolean): ResidentPhoneIdentity => ({
    residentId,
    verifiedPhone: null,
    phoneVerifierIds: [],
    state: { hasPhone, verified: false, ambiguous: false },
  });
  try {
    const { data } = await db
      .from("profiles")
      .select("id, phone, phone_verified_at")
      .eq("id", residentId)
      .maybeSingle();
    if (!data) return none(false);
    const hasPhone = Boolean(clean((data as Row).phone));
    const phone = normalizeE164((data as Row).phone);
    if (!phone || !(data as Row).phone_verified_at) return none(hasPhone);

    const { data: owners } = await db
      .from("profiles")
      .select("id, phone, phone_verified_at")
      .in("phone", profilePhoneVariants(phone))
      .not("phone_verified_at", "is", null);
    const verifierIds = [
      ...new Set(
        ((owners ?? []) as Row[])
          .filter((row) => normalizeE164(row.phone) === phone)
          .map((row) => clean(row.id))
          .filter(Boolean),
      ),
    ];
    if (!verifierIds.includes(residentId)) verifierIds.push(residentId);
    return {
      residentId,
      verifiedPhone: phone,
      phoneVerifierIds: verifierIds,
      state: { hasPhone: true, verified: true, ambiguous: verifierIds.length > 1 },
    };
  } catch {
    return none(false);
  }
}

/** Who each workspace is, in the words a resident sees: manager name, workspace, work number. */
export async function loadResidentCounterparties(
  db: Db,
  workspaceIds: readonly string[],
): Promise<Map<string, ResidentCounterparty>> {
  const out = new Map<string, ResidentCounterparty>();
  const ids = [...new Set(workspaceIds.map(clean).filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data: workspaces } = await db.from("portal_workspaces").select("id, name, owner_user_id").in("id", ids);
    const rows = (workspaces ?? []) as Row[];
    const ownerIds = [...new Set(rows.map((row) => clean(row.owner_user_id)).filter(Boolean))];
    const [{ data: owners }, { data: lines }] = await Promise.all([
      ownerIds.length ? db.from("profiles").select("id, full_name").in("id", ownerIds) : Promise.resolve({ data: [] }),
      db.from("manager_sms_numbers").select("workspace_id, phone_number, provision_state").in("workspace_id", ids),
    ]);
    const ownerName = new Map(((owners ?? []) as Row[]).map((row) => [clean(row.id), clean(row.full_name)]));
    const workPhone = new Map<string, string>();
    for (const line of (lines ?? []) as Row[]) {
      if (clean(line.provision_state) !== "active") continue;
      const phone = normalizeE164(line.phone_number);
      if (phone && !workPhone.has(clean(line.workspace_id))) workPhone.set(clean(line.workspace_id), phone);
    }
    for (const row of rows) {
      const id = clean(row.id);
      const workspaceName = clean(row.name) || null;
      const name = ownerName.get(clean(row.owner_user_id)) || workspaceName || "Property manager";
      out.set(id, {
        workspaceId: id,
        name,
        workspaceName,
        workPhone: workPhone.get(id) ?? null,
        avatarUrl: null,
        initials: initialsOf(name),
      });
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * Which of these workspaces the resident is actually linked to (an application
 * or lease with that workspace's owner or co-managers, through a house IN that
 * workspace). A conversation key on a stored row is a claim, never a link: only
 * a workspace named here may have its manager's name and work number stamped on
 * the resident's list. A failed read links nothing.
 *
 * Every workspace asked about is checked, `LINK_CHECK_CONCURRENCY` at a time.
 * `maxChecks` puts a ceiling on that for a caller that is guessing rather than
 * reading the resident's own conversations; the surviving set is chosen in id
 * order, so it is the same on every load.
 */
export async function loadResidentLinkedWorkspaceIds(
  db: Db,
  residentId: string,
  workspaceIds: readonly string[],
  options: { maxChecks?: number } = {},
): Promise<Set<string>> {
  const linked = new Set<string>();
  const ids = [...new Set(workspaceIds.map(clean).filter(Boolean))];
  const resident = clean(residentId);
  if (!resident || ids.length === 0) return linked;
  try {
    const { data } = await db.from("portal_workspaces").select("id, owner_user_id, is_default").in("id", ids);
    // Workspaces that really exist, in a stable order: a forged key falls out
    // at the read above, and a ceiling is applied to what survives it.
    const checkable = ((data ?? []) as Row[])
      .flatMap((workspace) => {
        const workspaceId = clean(workspace.id);
        const owner = clean(workspace.owner_user_id);
        return workspaceId && owner ? [{ workspaceId, owner, isDefault: workspace.is_default === true }] : [];
      })
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
      .slice(0, options.maxChecks ?? Infinity);
    // A few at a time: a resident's Communication list waits on this before it
    // can name a single row, and each check is ~6 independent reads.
    for (let start = 0; start < checkable.length; start += LINK_CHECK_CONCURRENCY) {
      const batch = await Promise.all(
        checkable.slice(start, start + LINK_CHECK_CONCURRENCY).map((workspace) =>
          loadAccountCandidates(
            db,
            { workspaceId: workspace.workspaceId, workspaceOwnerId: workspace.owner, isDefault: workspace.isDefault },
            workspace.owner,
            { accountId: resident },
          ).then((candidates) =>
            candidates.some((candidate) => candidate.id === resident && candidate.linked)
              ? workspace.workspaceId
              : null,
          ),
        ),
      );
      for (const workspaceId of batch) if (workspaceId) linked.add(workspaceId);
    }
  } catch {
    return new Set();
  }
  return linked;
}

/**
 * How many of ONE manager's workspaces a resident's list read will probe for a
 * link before giving up on naming their legacy rows. The answer needs exactly
 * one linked workspace, and the default is probed first.
 */
const MAX_WORKSPACE_PROBES_PER_MANAGER = 3;

/**
 * Older rows (before conversation keys) carry no `ws:` key, only the other party's ACCOUNT email.
 * Those are named from that email, under conditions that keep this from being a lookup oracle: the
 * email is one a SERVER-written row of the resident's already carries (see `needsEmailNaming` -
 * never a value a browser put in `row_data`), its profile holds a manager role (`profile_roles`),
 * and the manager owns a workspace the resident is really linked to. A workspace the resident is
 * not linked to, or an email that is not a manager's, resolves to nothing. The manager's WORK email
 * never appears on these rows, so the contact list cannot match them.
 */
export async function loadResidentManagerCounterpartiesByEmail(
  db: Db,
  residentId: string,
  emails: readonly string[],
): Promise<Map<string, ResidentCounterparty>> {
  const out = new Map<string, ResidentCounterparty>();
  const wanted = [
    ...new Set(emails.map((email) => clean(email).toLowerCase()).filter((email) => email.includes("@"))),
  ].slice(0, MAX_NAMED_EMAILS);
  const resident = clean(residentId);
  if (!resident || wanted.length === 0) return out;
  try {
    // `profiles.email` is plain text with no case normalization, so an account
    // stored as `Maya@x.co` has to match the row's lowercased `maya@x.co`: the
    // case-insensitive match the scheduled-message resolver also falls back to.
    // A pattern character would turn `ilike` into a scan, so such an address is
    // never asked for, and every row that comes back is re-matched exactly.
    const filter = wanted
      .filter((email) => !/[%*]/.test(email))
      .map((email) => `email.ilike.${postgrestFilterValue(email)}`)
      .join(",");
    if (!filter) return out;
    const { data: profiles } = await db.from("profiles").select("id, email").or(filter);
    const idByEmail = new Map<string, string>();
    for (const row of (profiles ?? []) as Row[]) {
      const id = clean(row.id);
      const email = clean(row.email).toLowerCase();
      if (id && email && id !== resident && wanted.includes(email)) idByEmail.set(email, id);
    }
    if (idByEmail.size === 0) return out;
    const { data: roles } = await db
      .from("profile_roles")
      .select("user_id, role")
      .in("user_id", [...idByEmail.values()])
      .eq("role", "manager");
    const managerIds = new Set(((roles ?? []) as Row[]).map((row) => clean(row.user_id)).filter(Boolean));
    if (managerIds.size === 0) return out;
    const { data: workspaces } = await db
      .from("portal_workspaces")
      .select("id, owner_user_id, is_default")
      .in("owner_user_id", [...managerIds]);
    // Each manager's workspaces, in the order they are worth probing: the
    // default one first, then by id - a STABLE order, so the same row is never
    // labelled with one workspace's name and work number on one load and
    // another's on the next (`counterparty.workPhone` is the number the
    // resident is told to text).
    const byOwner = new Map<string, string[]>();
    for (const row of [...((workspaces ?? []) as Row[])].sort(
      (a, b) =>
        Number(b.is_default === true) - Number(a.is_default === true) || clean(a.id).localeCompare(clean(b.id)),
    )) {
      const owner = clean(row.owner_user_id);
      const id = clean(row.id);
      if (!owner || !id) continue;
      const probes = byOwner.get(owner) ?? [];
      if (probes.length < MAX_WORKSPACE_PROBES_PER_MANAGER) probes.push(id);
      byOwner.set(owner, probes);
    }
    // One workspace per manager, found in ROUNDS rather than by checking every
    // workspace of every manager: each round checks one candidate per manager
    // still unplaced, and a manager drops out as soon as one of theirs is
    // linked. The ordinary list read is a single round - the default workspace.
    const chosen = new Map<string, string>();
    // One budget for the WHOLE path, spent across the rounds. Passing the ceiling to each round
    // would let a list read with many legacy managers spend it over again every round.
    let checksLeft = MAX_EMAIL_NAMING_LINK_CHECKS;
    for (let round = 0; round < MAX_WORKSPACE_PROBES_PER_MANAGER; round += 1) {
      if (checksLeft <= 0) break;
      const probe = [...byOwner]
        .filter(([owner]) => !chosen.has(owner))
        .map(([, probes]) => probes[round])
        .filter((id): id is string => Boolean(id))
        .slice(0, checksLeft);
      if (probe.length === 0) break;
      checksLeft -= probe.length;
      const linked = await loadResidentLinkedWorkspaceIds(db, resident, probe, {
        maxChecks: probe.length,
      });
      for (const [owner, probes] of byOwner) {
        const id = probes[round];
        if (id && !chosen.has(owner) && linked.has(id)) chosen.set(owner, id);
      }
    }
    const identities = await loadResidentCounterparties(db, [...chosen.values()]);
    for (const [email, managerId] of idByEmail) {
      const identity = identities.get(chosen.get(managerId) ?? "");
      if (identity) out.set(email, identity);
    }
  } catch {
    return new Map();
  }
  return out;
}

type ProjectionRow = {
  id: string;
  owner: string;
  role: string;
  workLineId: string | null;
  workspaceId: string | null;
  userId: string | null;
  phone: string | null;
};

const SUMMARY_COLUMNS =
  "id, owner_manager_user_id, counterparty_role, work_line_id, counterparty_user_id, counterparty_phone, workspace_id, merged_into_id";

function mapProjection(row: Row): ProjectionRow {
  return {
    id: clean(row.id),
    owner: clean(row.owner_manager_user_id),
    role: clean(row.counterparty_role),
    workLineId: clean(row.work_line_id) || null,
    workspaceId: clean(row.workspace_id) || null,
    userId: clean(row.counterparty_user_id) || null,
    phone: clean(row.counterparty_phone) || null,
  };
}

/** Candidate projection summaries: the account's own, plus the verified phone's. Decided afterwards. */
async function readProjectionCandidates(db: Db, identity: ResidentPhoneIdentity): Promise<ProjectionRow[]> {
  const byId = new Map<string, ProjectionRow>();
  const reads: Promise<{ data: unknown }>[] = [
    db
      .from("sms_projection_conversations")
      .select(SUMMARY_COLUMNS)
      .eq("counterparty_user_id", identity.residentId)
      .is("merged_into_id", null)
      .limit(MAX_CONVERSATIONS) as unknown as Promise<{ data: unknown }>,
  ];
  if (identity.verifiedPhone && !identity.state.ambiguous) {
    reads.push(
      db
        .from("sms_projection_conversations")
        .select(SUMMARY_COLUMNS)
        .in("counterparty_phone", profilePhoneVariants(identity.verifiedPhone))
        .is("merged_into_id", null)
        .limit(MAX_CONVERSATIONS) as unknown as Promise<{ data: unknown }>,
    );
  }
  for (const { data } of await Promise.all(reads)) {
    for (const row of (data ?? []) as Row[]) {
      const mapped = mapProjection(row);
      if (mapped.id) byId.set(mapped.id, mapped);
    }
  }
  return [...byId.values()];
}

async function readTurns(db: Db, conversationId: string): Promise<ResidentSmsTurn[]> {
  const { data } = await db
    .from("sms_projection_turns")
    .select("id, direction, body, occurred_at, from_phone, to_phone")
    .eq("conversation_id", conversationId)
    .order("occurred_at", { ascending: false })
    .limit(TURNS_PER_CONVERSATION);
  return ((data ?? []) as Row[]).flatMap((row) => {
    const direction = clean(row.direction);
    const at = clean(row.occurred_at);
    if ((direction !== "inbound" && direction !== "outbound") || !Number.isFinite(Date.parse(at))) return [];
    return [
      {
        id: clean(row.id),
        direction,
        body: typeof row.body === "string" ? row.body : "",
        at,
        fromPhone: clean(row.from_phone) || null,
        toPhone: clean(row.to_phone) || null,
      } satisfies ResidentSmsTurn,
    ];
  });
}

/**
 * The text conversations that are this resident's, ONE per manager workspace.
 *
 * The workspace of a conversation is the workspace that owns the work line it
 * happened on, read from the line itself: a summary's stamped workspace is a
 * hint, never the answer, so a mis-stamped row cannot move a text into another
 * workspace's conversation. A conversation whose line cannot be placed is
 * dropped rather than guessed.
 */
export async function loadResidentSmsConversations(
  db: Db,
  residentId: string,
  preloaded?: ResidentPhoneIdentity,
): Promise<{ conversations: ResidentSmsConversation[]; phone: ResidentPhoneState }> {
  const id = clean(residentId);
  if (!id) return { conversations: [], phone: { hasPhone: false, verified: false, ambiguous: false } };
  const identity = preloaded ?? (await loadResidentPhoneIdentity(db, id));
  try {
    const candidates = await readProjectionCandidates(db, identity);
    const mine: { row: ProjectionRow; linkedBy: "account" | "verified_phone" }[] = [];
    for (const row of candidates) {
      const linkedBy = decideResidentSmsLink({
        residentId: id,
        verifiedPhone: identity.verifiedPhone,
        phoneVerifierIds: identity.phoneVerifierIds,
        row: { role: row.role, counterpartyUserId: row.userId, counterpartyPhone: row.phone },
      });
      if (linkedBy) mine.push({ row, linkedBy });
    }
    if (mine.length === 0) return { conversations: [], phone: identity.state };

    // Place each on its line's workspace.
    const lineIds = [...new Set(mine.map((entry) => entry.row.workLineId).filter((value): value is string => Boolean(value)))];
    const lineWorkspace = new Map<string, string>();
    if (lineIds.length) {
      const { data } = await db.from("manager_sms_numbers").select("id, workspace_id").in("id", lineIds);
      for (const line of (data ?? []) as Row[]) {
        if (clean(line.workspace_id)) lineWorkspace.set(clean(line.id), clean(line.workspace_id));
      }
    }
    const byWorkspace = new Map<string, { rows: ProjectionRow[]; linkedBy: Set<"account" | "verified_phone"> }>();
    for (const entry of mine) {
      const workspaceId = entry.row.workLineId ? lineWorkspace.get(entry.row.workLineId) : undefined;
      if (!workspaceId) continue;
      const bucket = byWorkspace.get(workspaceId) ?? { rows: [], linkedBy: new Set() };
      bucket.rows.push(entry.row);
      bucket.linkedBy.add(entry.linkedBy);
      byWorkspace.set(workspaceId, bucket);
    }
    if (byWorkspace.size === 0) return { conversations: [], phone: identity.state };

    const counterparties = await loadResidentCounterparties(db, [...byWorkspace.keys()]);
    const out: ResidentSmsConversation[] = [];
    for (const [workspaceId, bucket] of byWorkspace) {
      const counterparty = counterparties.get(workspaceId);
      if (!counterparty) continue;
      const turnSets = await Promise.all(bucket.rows.map((row) => readTurns(db, row.id)));
      const seen = new Set<string>();
      const turns = turnSets
        .flat()
        .filter((turn) => turn.id && !seen.has(turn.id) && seen.add(turn.id))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
        .slice(-TURNS_PER_CONVERSATION);
      if (turns.length === 0) continue;
      out.push({
        workspaceId,
        key: workspaceKey(workspaceId),
        counterparty,
        linkedBy: [...bucket.linkedBy],
        turns,
        lastEventAt: turns[turns.length - 1]!.at,
      });
    }
    out.sort((a, b) => Date.parse(b.lastEventAt ?? "") - Date.parse(a.lastEventAt ?? ""));
    return { conversations: out, phone: identity.state };
  } catch {
    return { conversations: [], phone: identity.state };
  }
}

export type VerifiedPhoneLinkResult = {
  /** Text conversations that now carry the resident's key. */
  stamped: number;
  /** Left alone: another account verified the number too, or the phone is no longer verified. */
  skipped: "ambiguous" | "unverified" | null;
};

/**
 * Verifying a phone links the texts that were already there: every past
 * conversation on that number, in every workspace, is re-keyed through the ONE
 * resolver (account -> verified phone). An account link only forms where the
 * resident really is linked to that workspace; otherwise the conversation keeps
 * its phone key, which is still theirs to read. Best-effort and idempotent: a
 * failure here never fails the verification that triggered it.
 */
export async function linkVerifiedPhoneHistory(db: Db, residentId: string): Promise<VerifiedPhoneLinkResult> {
  const identity = await loadResidentPhoneIdentity(db, clean(residentId));
  if (!identity.verifiedPhone) return { stamped: 0, skipped: "unverified" };
  if (identity.state.ambiguous) return { stamped: 0, skipped: "ambiguous" };
  let stamped = 0;
  try {
    const candidates = await readProjectionCandidates(db, identity);
    for (const row of candidates) {
      const link = decideResidentSmsLink({
        residentId: identity.residentId,
        verifiedPhone: identity.verifiedPhone,
        phoneVerifierIds: identity.phoneVerifierIds,
        row: { role: row.role, counterpartyUserId: row.userId, counterpartyPhone: row.phone },
      });
      // Only conversations that are THIS resident's are re-keyed, and only
      // prospect / applicant / resident ones (never a manager's or a vendor's).
      if (!link || !isResidentSmsRole(row.role) || !row.workLineId) continue;
      const workspaceId = (await workspaceIdForWorkLine(db, row.workLineId)) ?? null;
      if (!workspaceId) continue;
      const ref = await resolveSmsConversationRef(db, {
        ownerManagerUserId: row.owner,
        workLineId: row.workLineId,
        workspaceId,
        counterpartyUserId: row.userId,
        counterpartyPhone: row.phone,
      });
      if (!ref || ref.flagged) continue;
      const { data, error } = await db.rpc("stamp_sms_projection_conversation", {
        p_conversation_id: row.id,
        p_workspace: ref.workspaceId,
        p_key: ref.key,
      });
      if (!error && data === true) stamped += 1;
    }
  } catch {
    // Best-effort: the resident's read path derives the same answer without the stamp.
  }
  return { stamped, skipped: null };
}

/**
 * Which stored rows may be named from the email they carry.
 *
 * `row_data.email` is free text on a row a BROWSER created, so naming from it
 * on any row would answer "is this address my manager's?" for a guess the
 * resident typed. `thread_type` is the server's own column: a client upsert
 * always writes it null and an existing row keeps the stored value, so a
 * non-empty type means the SERVER wrote this row - and every server writer
 * (delivery, the send route, notifications) set `email` to a party it had
 * already authorized. A client-authored row keeps its 'Property manager'
 * fallback and nothing is looked up for it.
 */
function needsEmailNaming(row: PersistedInboxThread): boolean {
  return (
    !isResidentAssistantRow(row) &&
    !row.counterparty &&
    !String(row.conversationKey ?? "").startsWith("ws:") &&
    clean(row.threadType) !== ""
  );
}

/**
 * The resident's list, ready to return: every workspace-keyed row names who it
 * is with, and the texts that are theirs are folded into the SAME conversation.
 * The PropLane Assistant thread is passed through untouched - it has no manager
 * and no texts. `phone` tells the UI whether to offer "verify your number".
 */
export async function applyResidentConversationExtras(
  db: Db,
  resident: { id: string; name?: string | null; mayReadResidentTexts: boolean },
  rows: PersistedInboxThread[],
): Promise<{ rows: PersistedInboxThread[]; phone: ResidentPhoneState }> {
  const empty: ResidentPhoneState = { hasPhone: false, verified: false, ambiguous: false };
  let phone = empty;
  let sms: ResidentSmsConversation[] = [];
  if (resident.mayReadResidentTexts) {
    const loaded = await loadResidentSmsConversations(db, resident.id);
    sms = loaded.conversations;
    phone = loaded.phone;
  }
  const keyedWorkspaces = rows
    .filter((row) => !isResidentAssistantRow(row) && String(row.conversationKey ?? "").startsWith("ws:"))
    .map((row) => String(row.conversationKey).slice(3));
  // Only workspaces the resident is really linked to are named. A key on a
  // stored row is a claim (a client once wrote `ws:<any uuid>`), so it is
  // checked; a workspace a verified-SMS conversation came from is linked by
  // construction.
  const linkedKeyed = await loadResidentLinkedWorkspaceIds(db, resident.id, keyedWorkspaces);
  const identities = await loadResidentCounterparties(db, [...linkedKeyed, ...sms.map((entry) => entry.workspaceId)]);
  const stampedByKey = stampCounterparties(rows, identities);
  // Rows with no workspace key are named from their own manager email (see the
  // loader) - ONE predicate, so the rows that contribute an email and the rows
  // that are stamped from it can never drift apart.
  const unkeyedEmails = stampedByKey.filter(needsEmailNaming).map((row) => row.email);
  const byEmail = await loadResidentManagerCounterpartiesByEmail(db, resident.id, unkeyedEmails);
  const stamped = byEmail.size
    ? stampedByKey.map((row) => {
        if (!needsEmailNaming(row)) return row;
        const identity = byEmail.get(clean(row.email).toLowerCase());
        return identity ? { ...row, counterparty: identity } : row;
      })
    : stampedByKey;
  const merged = mergeResidentSmsConversations(stamped, sms, clean(resident.name) || "You");
  return { rows: merged, phone };
}
