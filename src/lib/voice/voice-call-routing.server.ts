import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { ManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/twilio";
import { resolveOwnedWorkNumber } from "@/lib/voice/manager-voice-inbound.server";

export const MANAGER_VOICE_UNCONFIGURED_PROMPT = "This number is not configured.";

export type VoiceCallRoute =
  | { kind: "manager"; identity: ManagerSmsInboundIdentity }
  | { kind: "resident"; ctx: ResidentAgentContext; residentUserId: string }
  | { kind: "prospect" };

export type ResolvedVoiceCall =
  | { ok: false; reason: "unconfigured" }
  | { ok: true; managerId: string; workNumber: string; route: VoiceCallRoute };

/** Same fork order as `/api/twilio/inbound` SMS: manager → resident → prospect. */
export async function resolveVoiceCallRoute(
  db: SupabaseClient,
  args: { fromPhone: string; toPhone: string },
): Promise<ResolvedVoiceCall> {
  const owned = await resolveOwnedWorkNumber(db, args.toPhone);
  if (!owned) return { ok: false, reason: "unconfigured" };

  const workNumber = normalizeE164(args.toPhone) ?? args.toPhone.trim();
  const managerInbound = await resolveManagerSmsInboundIdentity(db, {
    workNumberOwnerId: owned.managerId,
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
  });
  if (managerInbound) {
    return {
      ok: true,
      managerId: owned.managerId,
      workNumber,
      route: { kind: "manager", identity: managerInbound },
    };
  }

  const residentIdentity = await resolveResidentSmsAgentContext(db, {
    fromPhone: args.fromPhone,
    ownerManagerUserId: owned.managerId,
  });
  if (residentIdentity.ok) {
    return {
      ok: true,
      managerId: owned.managerId,
      workNumber,
      route: {
        kind: "resident",
        ctx: residentIdentity.ctx,
        residentUserId: residentIdentity.ctx.userId,
      },
    };
  }

  return {
    ok: true,
    managerId: owned.managerId,
    workNumber,
    route: { kind: "prospect" },
  };
}

export function voiceGreetingForRoute(route: VoiceCallRoute): string {
  switch (route.kind) {
    case "manager":
      return "PropLane assistant. How can I help with tours or property today?";
    case "resident":
      return "PropLane resident assistant. I can help with your lease, payments, or maintenance. What do you need?";
    case "prospect":
      return "Thanks for calling. I can help with available homes and tour times. What are you looking for?";
  }
}

export function voiceCounterpartyRole(route: VoiceCallRoute): SmsCounterpartyRole {
  switch (route.kind) {
    case "manager":
      return "manager";
    case "resident":
      return "resident";
    case "prospect":
      return "prospect";
  }
}

export function voiceCallLogIdentity(args: {
  managerId: string;
  workNumber: string;
  fromPhone: string;
  route: VoiceCallRoute;
}): {
  managerUserId: string;
  actorUserId: string;
  actorPhone: string;
  workNumber: string;
  counterpartyRole: SmsCounterpartyRole;
} {
  const fromPhone = args.fromPhone.trim();
  switch (args.route.kind) {
    case "manager":
      return {
        managerUserId: args.managerId,
        actorUserId: args.route.identity.actorUserId,
        actorPhone: args.route.identity.actorPhone,
        workNumber: args.route.identity.workNumber,
        counterpartyRole: "manager",
      };
    case "resident":
      return {
        managerUserId: args.managerId,
        actorUserId: args.route.residentUserId,
        actorPhone: fromPhone,
        workNumber: args.workNumber,
        counterpartyRole: "resident",
      };
    case "prospect":
      return {
        managerUserId: args.managerId,
        actorUserId: args.managerId,
        actorPhone: fromPhone,
        workNumber: args.workNumber,
        counterpartyRole: "prospect",
      };
  }
}

export async function ensureManagerVoiceAgentContext(
  db: SupabaseClient,
  route: Extract<VoiceCallRoute, { kind: "manager" }>,
) {
  return resolveManagerSmsAgentContext(db, {
    managerUserId: route.identity.workNumberOwnerId,
    actorUserId: route.identity.actorUserId,
    access: route.identity.access,
  });
}
