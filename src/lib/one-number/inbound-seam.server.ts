import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EMERGENCY_SAFETY_REPLY,
  type SharedLineCandidate,
  type SharedLineConfig,
  type SharedLineInbound,
} from "@/lib/one-number/contracts";
import { workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { groupPreferenceCommand } from "@/lib/house-groups/ra-policy";
import { runDemoTurn } from "@/lib/one-number/demo/run-demo-turn.server";
import { isDemoStartText } from "@/lib/one-number/demo/script";
import { hasLiveDemo } from "@/lib/one-number/demo/store.server";
import { handleInviteCommand, inviteCommandApplies } from "@/lib/one-number/onboarding/invite.server";
import { classifySharedLineKeyword } from "@/lib/one-number/keywords";
import { routeSharedLineInboundWithReply } from "@/lib/one-number/router.server";
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

/**
 * The shared-line seam of `/api/twilio/inbound`: keywords (HUMAN, emergency),
 * routing, the ambiguity question, the Unassigned-leads hand-off. STOP / START /
 * HELP are handled by the route before this runs. Routed texts continue into the
 * existing pipeline as the workspace owner; every other outcome is answered here.
 */
export async function handleSharedLineInbound(db: SupabaseClient, input: SeamInput): Promise<SharedLineSeamResult> {
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
  let routed = await routeSharedLineInboundWithReply(db, inbound, session, { dryRun: keyword === "HUMAN", dedicatedWorkspaceIds });
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
      return { kind: "handled", twiml: `${EMERGENCY_SAFETY_REPLY} ${redirect}` };
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
      const text = keyword === "EMERGENCY" ? EMERGENCY_SAFETY_REPLY : routed.unassignedReply;
      // The lead agent's one real listing photo rides the reply as TwiML <Media>; never an emergency text.
      const photo = keyword === "EMERGENCY" ? null : routed.unassignedMediaUrls?.[0];
      const messages = keyword !== "EMERGENCY" && routed.unassignedReplies?.length ? routed.unassignedReplies : undefined;
      const bubbles = messages
        ? messages.map((body, index) => (index === 0 && photo ? { body, mediaUrl: photo } : { body }))
        : undefined;
      return {
        kind: "handled",
        twiml: text,
        ...(messages ? { messages, bubbles } : {}),
        ...(photo && text ? { mediaUrl: photo } : {}),
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
      await settle("reply", reply(db, decision.candidates[0], input, EMERGENCY_SAFETY_REPLY, "emergency"));
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
    await settle("reply", reply(db, candidate, input, EMERGENCY_SAFETY_REPLY, "emergency"));
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
