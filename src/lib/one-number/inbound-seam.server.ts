import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type SharedLineCandidate,
  type SharedLineConfig,
  type SharedLineInbound,
} from "@/lib/one-number/contracts";
import { workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { readServiceOwnerOrThrow } from "@/lib/one-number/service-line.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { holdsAdminRole } from "@/lib/sms/service-manager-inbound.server";
import { groupPreferenceCommand } from "@/lib/house-groups/ra-policy";
import { runDemoTurn } from "@/lib/one-number/demo/run-demo-turn.server";
import { isDemoStartText } from "@/lib/one-number/demo/script";
import { hasLiveDemo } from "@/lib/one-number/demo/store.server";
import { handleInviteCommand, inviteCommandApplies } from "@/lib/one-number/onboarding/invite.server";
import { classifySharedLineKeyword, emergencyReplyFor } from "@/lib/one-number/keywords";
import { gatherCandidates, routeSharedLineInboundWithReply } from "@/lib/one-number/router.server";
import { isHousingSearchText } from "@/lib/one-number/line-intent";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { loadSharedLineSession, pauseThreadAi, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { answerFromDedicatedWorkspace } from "@/lib/one-number/dedicated-redirect.server";
import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";
import { normalizeE164 } from "@/lib/phone-e164";

export const HUMAN_ACK_REPLY = "Got it. A person from your property team will text you shortly.";

export type SharedLineSeamResult =
  /** Fully answered here. Respond to Twilio with `twiml` (empty when null) and stop. */
  | {
      kind: "handled";
      twiml: string | null;
      mediaUrl?: string;
      /** Several texts in order (each may carry its own https photo); `twiml` is them joined. */
      messages?: string[];
      bubbles?: { body: string; mediaUrl?: string }[];
    }
  /** Run the existing inbound pipeline as this workspace, exactly as a work-number inbound would. */
  | { kind: "continue"; owned: { managerId: string; workspaceId: string; messagingServiceSid: string } }
  /** Nothing to route (shared line off for this text): the existing no-owner path logs it. */
  | { kind: "none" };

type SeamInput = {
  config: SharedLineConfig;
  fromPhone: string;
  body: string;
  messageSid: string;
  mediaCount: number;
  phoneKey: string;
};

/** Never let one failed side effect (a text, an alert) stop the others or the routing. */
async function settle(label: string, work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    console.error(`shared line ${label} failed`, error instanceof Error ? error.name : "unknown");
  }
}

function peopleText(fromPhone: string, what: string): string {
  const e164 = normalizeE164(fromPhone) ?? fromPhone;
  return `${what} from ${e164}`;
}

async function reply(
  db: SupabaseClient,
  candidate: SharedLineCandidate,
  input: SeamInput,
  body: string,
  keyPart: string,
): Promise<void> {
  const toPhone = normalizeE164(input.fromPhone) ?? input.fromPhone;
  const result = await sendSharedLineMessage(db, {
    workspaceId: candidate.workspaceId,
    ownerUserId: candidate.ownerUserId,
    toPhone,
    body,
    role: candidate.role,
    idempotencyKey: `shared-line:${keyPart}:${input.messageSid}`,
  });
  if (!result.ok) console.warn("shared line reply not sent", keyPart, result.reason);
}

/** True when every tie this phone has is a residency and the text is a housing search ("is there any house available"). */
async function residentSearchingForHousing(db: SupabaseClient, inbound: SharedLineInbound): Promise<boolean> {
  if (!isHousingSearchText(inbound.body)) return false;
  try {
    const candidates = await gatherCandidates(db, inbound);
    return candidates.length > 0 && candidates.every((c) => c.role === "resident");
  } catch {
    return false;
  }
}

/**
 * A text from a PLATFORM ADMIN's own verified phone is that admin talking to their PropLane Assistant, never a stranger
 * and never a routable person. Recognised by `profile_roles` only, on a phone verified and held by exactly one profile
 * (`findVerifiedProfileByPhone`). The text continues into the manager pipeline as the PropLane service owner's line, where
 * `recognizeServiceManagerInbound` re-derives the same admin from the same phone, runs the manager agent as THAT admin, and
 * mirrors the turn into that admin's own Assistant thread (keyed by the admin, so no other admin ever reads it). Anything
 * ambiguous or unreadable is not an admin here: the text takes today's path.
 */
async function adminAssistantContinuation(
  db: SupabaseClient,
  input: SeamInput,
): Promise<Extract<SharedLineSeamResult, { kind: "continue" }> | null> {
  try {
    const profile = await findVerifiedProfileByPhone(db, input.fromPhone);
    if (!profile) return null;
    if (!(await holdsAdminRole(db, profile.id))) return null;
    const serviceOwner = await readServiceOwnerOrThrow(db);
    if (!serviceOwner) return null;
    const workspaceId = await userDefaultWorkspaceId(db, serviceOwner);
    if (!workspaceId) return null;
    return {
      kind: "continue",
      owned: { managerId: serviceOwner, workspaceId, messagingServiceSid: input.config.messagingServiceSid ?? "" },
    };
  } catch {
    return null;
  }
}

/**
 * The shared-line seam of `/api/twilio/inbound`: keywords (HUMAN, emergency),
 * routing, the ambiguity question, the Unassigned-leads hand-off. STOP / START /
 * HELP are handled by the route before this runs. Routed texts continue into the
 * existing pipeline as the workspace owner; every other outcome is answered here.
 */
export async function handleSharedLineInbound(db: SupabaseClient, input: SeamInput): Promise<SharedLineSeamResult> {
  // An admin's own phone talks to their Assistant: before groups, redirects, the owner line and the router, none of which
  // is about them, and so no Unassigned lead is ever made from an admin's text.
  const adminContinuation = await adminAssistantContinuation(db, input);
  if (adminContinuation) return adminContinuation;
  // "leave group" / "join group" (house group chats): answered here, before routing, when the sender is a resident of a chat-enabled house.
  const groupCommand = groupPreferenceCommand(input.body);
  if (groupCommand) {
    try {
      const { handleGroupPreferenceText } = await import("@/lib/house-groups/ra.server");
      const handled = await handleGroupPreferenceText(db, { fromPhone: input.fromPhone, command: groupCommand, messageSid: input.messageSid });
      if (handled.handled) return { kind: "handled", twiml: handled.reply };
    } catch (error) {
      console.error("house group preference failed", error instanceof Error ? error.name : "unknown");
    }
  }
  // Someone who pays for their own PropLane number (a resident's, or a vendor's routable one) is pointed at it before any
  // routing, in both line modes (`line-inbound.server.ts` does the same on the per_workspace line). Lapsed = served here.
  try {
    const { personalNumberRedirectFor } = await import("@/lib/one-number/personal-number-redirect.server");
    const redirect = await personalNumberRedirectFor(db, { fromPhone: input.fromPhone, body: input.body });
    if (redirect) return { kind: "handled", twiml: redirect.reply };
  } catch (error) {
    console.error("personal number redirect failed", error instanceof Error ? error.name : "unknown");
  }
  // The owner of a PropLane-managed workspace asking about their house, or answering a repair approval. The router's team lane
  // excludes owners and its role contracts are fixed, so this answers first, only for clearly owner questions; everything else
  // (and everyone else) falls straight through to normal routing.
  try {
    const { handleOwnerLine } = await import("@/lib/owner-management/owner-line.server");
    const owner = await handleOwnerLine(db, { fromPhone: input.fromPhone, body: input.body });
    if (owner.handled) return { kind: "handled", twiml: owner.reply };
  } catch (error) {
    console.error("owner line failed", error instanceof Error ? error.name : "unknown");
  }
  // on/smsowner: the owner of record of a PropLane Service workspace (a client seated as a Property owner) is not a
  // routable team member, so without this a status question from them reads as a stranger's. Read-only status of
  // their own workspace; anything that is not a status question (or a housing search) is not handled here.
  try {
    const { handleLineMemberText } = await import("@/lib/one-number/line-member-status.server");
    const member = await handleLineMemberText(db, { fromPhone: input.fromPhone, body: input.body, phoneKey: input.phoneKey, mode: "shared_line", messageSid: input.messageSid });
    if (member.handled) return { kind: "handled", twiml: member.reply };
  } catch (error) {
    console.error("line member status failed", error instanceof Error ? error.name : "unknown");
  }
  const inbound: SharedLineInbound = {
    fromPhone: input.fromPhone,
    phoneKey: input.phoneKey,
    body: input.body,
    messageSid: input.messageSid,
    mediaCount: input.mediaCount,
  };
  const keyword = classifySharedLineKeyword(input.body);
  const session = await loadSharedLineSession(db, input.phoneKey);
  const dedicatedWorkspaceIds = input.config.dedicatedWorkspaceIds;
  // on/smsowner: a resident who is looking for a house is a prospect for that text, answered from the PropLane
  // catalog by the lead agent (their next text about rent or a repair is a resident's again).
  const asProspect = await residentSearchingForHousing(db, inbound);
  let routed = await routeSharedLineInboundWithReply(db, inbound, session, { dryRun: keyword === "HUMAN", dedicatedWorkspaceIds, asProspect });
  let decision = routed.decision;

  // Number model: someone whose only ties are workspaces with a number of their own is told, once,
  // to text that number. Nothing is routed, no agent runs, no lead is made.
  if (routed.dedicatedRedirect) {
    const candidate = routed.dedicatedRedirect;
    const redirect = await answerFromDedicatedWorkspace(db, {
      candidate, fromPhone: input.fromPhone, body: input.body, messageSid: input.messageSid, sharedNumber: input.config.sharedNumber,
    });
    if (!redirect) return { kind: "none" };
    if (keyword === "EMERGENCY" && candidate.role !== "manager") {
      await settle("alert", alertWorkspaceTeam(db, {
        workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, kind: "emergency", urgent: true,
        text: peopleText(input.fromPhone, `Emergency word in a text (${candidate.label}) sent to the PropLane line`), propertyId: candidate.propertyId,
        idempotencyKey: `emergency:${input.messageSid}:${candidate.workspaceId}`,
      }));
      return { kind: "handled", twiml: `${emergencyReplyFor(input.body)} ${redirect}` };
    }
    return { kind: "handled", twiml: redirect };
  }

  // A pilot only answers for its workspaces: anyone else on the shared line is not served yet.
  if (decision.kind === "routed" && !workspaceOnSharedLine(input.config, decision.workspaceId)) {
    return { kind: "none" };
  }
  if (decision.kind === "ambiguous") {
    const served = decision.candidates.filter((c) => workspaceOnSharedLine(input.config, c.workspaceId));
    if (served.length === 0) return { kind: "none" };
    if (served.length < decision.candidates.length) {
      decision = served.length === 1 ? { kind: "routed", ...served[0] } : { ...decision, candidates: served };
    }
  }

  if (decision.kind === "unassigned") {
    if (keyword === "HUMAN") {
      // A stranger asking for a person has no team yet: the lead queue still qualifies them.
      routed = await routeSharedLineInboundWithReply(db, inbound, session);
      decision = routed.decision;
    }
    if (decision.kind === "unassigned") {
      // No workspace to bill or sign off for: the reply rides the webhook's own TwiML.
      const text = keyword === "EMERGENCY" ? emergencyReplyFor(input.body) : routed.unassignedReply;
      // The lead agent's one real listing photo rides the reply as TwiML <Media>; never an emergency text.
      const photo = keyword === "EMERGENCY" ? null : routed.unassignedMediaUrls?.[0];
      const offerBubbles = keyword !== "EMERGENCY" && routed.unassignedBubbles?.length ? routed.unassignedBubbles : undefined;
      const messages = offerBubbles
        ? offerBubbles.map((b) => b.body)
        : keyword !== "EMERGENCY" && routed.unassignedReplies?.length ? routed.unassignedReplies : undefined;
      const bubbles = offerBubbles
        ?? (messages ? messages.map((body, index) => (index === 0 && photo ? { body, mediaUrl: photo } : { body })) : undefined);
      return {
        kind: "handled",
        twiml: text,
        ...(messages ? { messages, bubbles } : {}),
        ...(photo && text && !offerBubbles ? { mediaUrl: photo } : {}),
      };
    }
  }

  if (decision.kind === "ambiguous") {
    const people = decision.candidates.filter((c) => c.role !== "manager");
    if (keyword === "HUMAN") {
      for (const candidate of people) {
        await settle("pause", pauseThreadAi(db, { phoneKey: input.phoneKey, workspaceId: candidate.workspaceId, role: candidate.role, reason: "human_keyword" }));
        await settle("alert", alertWorkspaceTeam(db, {
          workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, kind: "human_request", urgent: false,
          text: peopleText(input.fromPhone, "Asked for a person"), propertyId: candidate.propertyId, idempotencyKey: `human:${input.messageSid}:${candidate.workspaceId}`,
        }));
      }
      await settle("reply", reply(db, decision.candidates[0], input, HUMAN_ACK_REPLY, "human"));
      return { kind: "handled", twiml: null };
    }
    if (keyword === "EMERGENCY") {
      await settle("reply", reply(db, decision.candidates[0], input, emergencyReplyFor(input.body), "emergency"));
      for (const candidate of people) {
        await settle("alert", alertWorkspaceTeam(db, {
          workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, kind: "emergency", urgent: true,
          text: peopleText(input.fromPhone, "Emergency word in a text"), propertyId: candidate.propertyId, idempotencyKey: `emergency:${input.messageSid}:${candidate.workspaceId}`,
        }));
      }
    }
    await settle("question", reply(db, decision.candidates[0], input, decision.question, "question"));
    return { kind: "handled", twiml: null };
  }

  // Routed to one workspace.
  const candidate: SharedLineCandidate = decision;
  const person = candidate.role !== "manager";
  // "invite <phone>" (only while the waitlist flag is on): a manager lets a landlord skip the waitlist.
  if (!person && inviteCommandApplies(input.body)) {
    const text = await handleInviteCommand(db, { workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, body: input.body, messageSid: input.messageSid }).catch(() => null);
    if (text) return { kind: "handled", twiml: text };
  }
  // A manager can run the sandbox DEMO from their own phone. While it lasts their texts are the demo's,
  // never the real manager agent's, and the demo touches no real workspace row.
  if (!person && (isDemoStartText(input.body) || (await hasLiveDemo(db, input.phoneKey).catch(() => false)))) {
    const demo = await runDemoTurn(db, { channel: "sms", sessionKey: input.phoneKey, text: input.body }).catch(() => null);
    if (demo?.ok) {
      return { kind: "handled", twiml: demo.messages.join("\n\n"), ...(demo.messages.length > 1 ? { messages: demo.messages } : {}) };
    }
  }
  if (keyword === "HUMAN" && person) {
    await settle("route", saveSharedLineRoute(db, input.phoneKey, { workspaceId: candidate.workspaceId, role: candidate.role }));
    await settle("pause", pauseThreadAi(db, { phoneKey: input.phoneKey, workspaceId: candidate.workspaceId, role: candidate.role, reason: "human_keyword" }));
    await settle("alert", alertWorkspaceTeam(db, {
      workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, kind: "human_request", urgent: false,
      text: peopleText(input.fromPhone, `Asked for a person (${candidate.label})`), propertyId: candidate.propertyId, idempotencyKey: `human:${input.messageSid}:${candidate.workspaceId}`,
    }));
    await settle("reply", reply(db, candidate, input, HUMAN_ACK_REPLY, "human"));
  } else if (keyword === "EMERGENCY" && person) {
    await settle("reply", reply(db, candidate, input, emergencyReplyFor(input.body), "emergency"));
    await settle("alert", alertWorkspaceTeam(db, {
      workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId, kind: "emergency", urgent: true,
      text: peopleText(input.fromPhone, `Emergency word in a text (${candidate.label})`), propertyId: candidate.propertyId, idempotencyKey: `emergency:${input.messageSid}:${candidate.workspaceId}`,
    }));
  }
  // The text itself continues into the existing pipeline (a paused thread skips the AI there, an
  // emergency still files the maintenance request).
  return {
    kind: "continue",
    owned: {
      managerId: candidate.ownerUserId,
      workspaceId: candidate.workspaceId,
      messagingServiceSid: input.config.messagingServiceSid ?? "",
    },
  };
}
