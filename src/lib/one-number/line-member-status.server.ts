import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { managedReadOnlyWorkspaceIds } from "@/lib/auth/managed-read-only.server";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { resolveWorkspaceDisplayNumber } from "@/lib/one-number/display-number.server";
import { classifyLineText } from "@/lib/one-number/line-intent";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import {
  STATUS_HELP_REPLY,
  buildStatusReply,
  buildWriteDeclineReply,
  type PortfolioStatus,
} from "@/lib/one-number/portfolio-status";
import { readPortfolioStatus, type PortfolioScope } from "@/lib/one-number/portfolio-status.server";
import { decideFromCandidates, textNamesCandidate } from "@/lib/one-number/router.server";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { loadSharedLineSession, saveSharedLinePending, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";

/**
 * Someone who runs houses on PropLane texts the PropLane line (the number the platform service owner holds in
 * per_workspace mode, or the shared number) and asks how their houses are doing. The line is not their own number:
 * it belongs to the PropLane service, so what they get here is STATUS, read-only, for the workspace(s) they
 * belong to and never any other.
 *
 *   owner            the workspace they own
 *   teammate         a workspace they were accepted into, narrowed to the houses assigned to them and the
 *                    modules granted on each (rent needs Payments, services needs Services, ...)
 *   owner_of_record  the client of a PropLane Service workspace, seated as a Property owner
 *                    (`is_owner_of_record`); their whole workspace, view only
 *
 * Identity is the VERIFIED phone on a profile (`findVerifiedProfileByPhone`: two claimants = nobody). Memberships are
 * re-derived from the database on every text; the sticky "which workspace" answer is a hint that is checked against
 * the memberships again. A text that is not a status question about their houses (a housing search, a stranger,
 * an unverified phone) is `handled: false` and falls through to exactly what happened before.
 */

export type LineMembershipKind = "owner" | "teammate" | "owner_of_record";

export type LineMembership = {
  workspaceId: string;
  workspaceName: string;
  ownerUserId: string;
  isDefault: boolean;
  kind: LineMembershipKind;
  /** The workspace is view only for this person everywhere (a managed client). */
  viewOnly: boolean;
};

export type LineMemberResult = { handled: false } | { handled: true; reply: string; actorUserId: string };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const KIND_RANK: Record<LineMembershipKind, number> = { owner: 0, teammate: 1, owner_of_record: 2 };

async function rows(query: PromiseLike<{ data: unknown; error: { code?: string | null } | null }>): Promise<Row[] | null> {
  try {
    const { data, error } = await query;
    if (error) return null;
    return Array.isArray(data) ? (data as Row[]) : [];
  } catch {
    return null;
  }
}

/**
 * Every workspace this account belongs to as an owner, an accepted teammate or the owner of record of a service
 * workspace. Null when the memberships could not be read: the caller then falls through, it never guesses.
 */
export async function listLineMemberships(
  db: SupabaseClient,
  profileId: string,
  options: { kinds?: readonly LineMembershipKind[] } = {},
): Promise<LineMembership[] | null> {
  const wants = (kind: LineMembershipKind) => !options.kinds || options.kinds.includes(kind);
  const [owned, teamInvites, recordInvites] = await Promise.all([
    wants("owner")
      ? rows(db.from("portal_workspaces").select("id, name, owner_user_id, is_default").eq("owner_user_id", profileId).limit(50))
      : Promise.resolve([] as Row[]),
    (async () => {
      if (!wants("teammate")) return [] as Row[];
      try {
        const result = withoutOwnerLinks(
          await db.from("account_link_invites").select("inviter_user_id, workspace_id, team_role").eq("invitee_user_id", profileId).eq("status", "accepted"),
        );
        return result.error ? null : ((result.data ?? []) as Row[]);
      } catch {
        return null;
      }
    })(),
    // The flag may not exist yet (code ahead of the migration): that reads as "nobody is an owner of record".
    (async () => {
      if (!wants("owner_of_record")) return [] as Row[];
      try {
        const { data, error } = await db
          .from("account_link_invites")
          .select("inviter_user_id, workspace_id")
          .eq("invitee_user_id", profileId)
          .eq("status", "accepted")
          .eq("team_role", "property_owner")
          .eq("is_owner_of_record", true);
        return error ? [] : ((data ?? []) as Row[]);
      } catch {
        return [];
      }
    })(),
  ]);
  if (owned === null || teamInvites === null) return null;

  const pinned = new Set<string>();
  const unpinnedInviters = new Set<string>();
  for (const invite of [...teamInvites, ...recordInvites]) {
    if (str(invite.workspace_id)) pinned.add(str(invite.workspace_id));
    else if (str(invite.inviter_user_id)) unpinnedInviters.add(str(invite.inviter_user_id));
  }
  const [pinnedWs, fallbackWs] = await Promise.all([
    pinned.size ? rows(db.from("portal_workspaces").select("id, name, owner_user_id, is_default, is_service").in("id", [...pinned])) : Promise.resolve([] as Row[]),
    unpinnedInviters.size
      ? rows(db.from("portal_workspaces").select("id, name, owner_user_id, is_default, is_service").in("owner_user_id", [...unpinnedInviters]).eq("is_default", true))
      : Promise.resolve([] as Row[]),
  ]);
  if (pinnedWs === null || fallbackWs === null) return null;
  const byId = new Map(pinnedWs.map((w) => [str(w.id), w] as const));
  const defaultOf = new Map(fallbackWs.map((w) => [str(w.owner_user_id), w] as const));

  let locked: Set<string>;
  try {
    locked = new Set(await managedReadOnlyWorkspaceIds(db, profileId));
  } catch {
    // Unknown whether it is view only: say view only. Nothing here writes, so this only changes the wording.
    locked = new Set([...owned.map((w) => str(w.id)), ...pinned]);
  }

  const out = new Map<string, LineMembership>();
  const add = (w: Row | undefined, kind: LineMembershipKind) => {
    const id = str(w?.id);
    if (!w || !id) return;
    const next: LineMembership = {
      workspaceId: id,
      workspaceName: str(w.name) || "your property team",
      ownerUserId: str(w.owner_user_id),
      isDefault: w.is_default === true,
      kind,
      viewOnly: locked.has(id),
    };
    const have = out.get(id);
    if (!have || KIND_RANK[kind] < KIND_RANK[have.kind]) out.set(id, next);
  };
  for (const w of owned) add(w, "owner");
  for (const invite of teamInvites) add(str(invite.workspace_id) ? byId.get(str(invite.workspace_id)) : defaultOf.get(str(invite.inviter_user_id)), "teammate");
  for (const invite of recordInvites) {
    const w = str(invite.workspace_id) ? byId.get(str(invite.workspace_id)) : undefined;
    // Only the client of a PropLane Service workspace is an owner of record.
    if (w && w.is_service === true) add(w, "owner_of_record");
  }
  return [...out.values()].filter((m) => m.ownerUserId).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.workspaceName.localeCompare(b.workspaceName));
}

/** The houses and modules a membership reaches: everything for an owner or owner of record, the grant for a teammate. */
export async function scopeForMembership(db: SupabaseClient, profileId: string, m: LineMembership): Promise<PortfolioScope | null> {
  const base = { db, ownerUserId: m.ownerUserId, workspaceId: m.workspaceId, workspaceName: m.workspaceName, workspaceIsDefault: m.isDefault };
  if (m.kind !== "teammate") return { ...base, propertyIds: null, canRead: () => true };
  const access = await resolveManagerSmsAccess(db, { actorUserId: profileId, workNumberOwnerId: m.ownerUserId });
  // A teammate with no assigned houses has nothing to read by text (the same rule the work-number agent applies).
  if (!access || access.mode !== "delegated") return null;
  const permissions = access.permissionsByOwner?.[m.ownerUserId];
  return {
    ...base,
    propertyIds: access.assignedPropertyIds,
    canRead: (propertyId, module) => coManagerModuleAllowed(permissions, propertyId, module, "read"),
  };
}

const SMALL_TALK = /^(?:hi|hey|hello|yo|thanks?|thank you|ty|ok|okay|k|cool|great|got it|yes|no|yep|nope|help|menu)\b[\s.!?]*$/;

const sessionKey = (phoneKey: string) => `ls:${phoneKey}`;

const candidateOf = (m: LineMembership): SharedLineCandidate => ({
  workspaceId: m.workspaceId,
  ownerUserId: m.ownerUserId,
  role: "manager",
  reason: "team_member",
  propertyId: null,
  label: m.workspaceName,
});

/** Narrow a status to the one house the text names, when it names exactly one. */
function narrowToNamedHouse(status: PortfolioStatus, body: string): PortfolioStatus {
  if (status.houses.length < 2) return status;
  const named = status.houses.filter((h) => textNamesCandidate(body, { label: h.title } as SharedLineCandidate));
  return named.length === 1 ? { ...status, houses: named } : status;
}

export type HandleLineMemberInput = {
  fromPhone: string;
  body: string;
  phoneKey: string;
  /** `service_line`: a PropLane Service number in per_workspace mode. `shared_line`: the shared number. */
  mode: "service_line" | "shared_line";
  /** service_line: the line owner. Their own workspaces are answered by the work-number agent, not here. */
  lineOwnerUserId?: string | null;
  now?: Date;
};

/**
 * Answer a member's text on the PropLane line. Deterministic and read-only: no model, no write, no figure it did not
 * read. `shared_line` serves only owners of record (owners and teammates are already routed to their workspace
 * there, with the full manager agent).
 */
export async function handleLineMemberText(db: SupabaseClient, input: HandleLineMemberInput): Promise<LineMemberResult> {
  const intent = classifyLineText(input.body, { member: true });
  if (intent.kind === "housing_search") return { handled: false };

  const profile = await findVerifiedProfileByPhone(db, input.fromPhone).catch(() => null);
  if (!profile) return { handled: false };
  const all = await listLineMemberships(db, profile.id, input.mode === "shared_line" ? { kinds: ["owner_of_record"] } : {}).catch(() => null);
  if (!all) return { handled: false };
  const memberships = all.filter((m) =>
    input.mode === "shared_line"
      ? m.kind === "owner_of_record"
      : !input.lineOwnerUserId || m.ownerUserId !== input.lineOwnerUserId,
  );
  if (memberships.length === 0) return { handled: false };
  const reply = (text: string): LineMemberResult => ({ handled: true, reply: text, actorUserId: profile.id });

  try {
    // A change request is declined with where to make it. It needs no workspace, only the wording.
    if (intent.kind === "write") {
      const only = memberships.length === 1 ? memberships[0]! : null;
      const number = only ? await resolveWorkspaceDisplayNumber(db, only.ownerUserId, only.workspaceId).catch(() => null) : null;
      const portalUrl = `${resolveEmailLinkBaseUrl()}${portalSignInHref("/portal")}`;
      return reply(buildWriteDeclineReply({ workNumber: number, portalUrl, viewOnly: memberships.every((m) => m.viewOnly) }));
    }

    // Which workspace? One membership is not a question. Several: the text may name one, the last answer
    // is remembered for the conversation, and otherwise we ask once.
    const key = sessionKey(input.phoneKey);
    const candidates = memberships.map(candidateOf);
    let chosen: LineMembership | null = memberships.length === 1 ? memberships[0]! : null;
    let answeredQuestion = false;
    if (!chosen) {
      const session = await loadSharedLineSession(db, key);
      const decided = decideFromCandidates({ body: input.body, candidates, session });
      if (decided.kind === "ambiguous") {
        await saveSharedLinePending(db, key, decided.candidates);
        return reply(decided.question);
      }
      if (decided.kind === "none") return { handled: false };
      chosen = memberships.find((m) => m.workspaceId === decided.candidate.workspaceId) ?? null;
      answeredQuestion = Boolean(session?.pendingCandidates?.length);
      if (chosen) await saveSharedLineRoute(db, key, { workspaceId: chosen.workspaceId, role: "manager" });
    }
    if (!chosen) return { handled: false };

    // A greeting or thanks gets the menu. Anything else without a status word ("1" answering our question,
    // "5259 Brooklyn") is read as "how is it going": the overview for that workspace or house.
    if (intent.kind === "other" && !answeredQuestion && SMALL_TALK.test(input.body.trim().toLowerCase())) return reply(STATUS_HELP_REPLY);
    const topic = intent.topic;

    const scope = await scopeForMembership(db, profile.id, chosen);
    if (!scope) return reply(`I do not see any houses assigned to you in ${chosen.workspaceName}.`);
    const status = narrowToNamedHouse(await readPortfolioStatus(scope, { now: input.now }), input.body);
    const text = buildStatusReply(status, topic);
    return reply(memberships.length > 1 && !text.toLowerCase().includes(chosen.workspaceName.toLowerCase()) ? `${chosen.workspaceName}: ${text}` : text);
  } catch (error) {
    console.error("line member status failed", error instanceof Error ? error.name : "unknown");
    return reply("I could not read your houses just now. Try again in a minute.");
  }
}
