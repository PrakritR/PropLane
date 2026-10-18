import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { waitlistConfig } from "@/lib/one-number/onboarding/waitlist.server";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * "invite 206 555 0100" from an existing manager: texts a landlord a finish-setup link that skips the
 * waitlist. Only live while `ONE_NUMBER_WAITLIST` is on (otherwise nobody needs an invite, and the text
 * goes to the manager agent as usual). It is a keyword command, like HUMAN, not an agent action: the
 * manager typed the number. Capped at 5 invites a day per workspace, and the text goes out through the
 * normal shared-line send path (opt-out ledger, quiet hours, shield, the workspace wallet).
 */
export const INVITES_PER_WORKSPACE_PER_DAY = 5;

/** The phone in an "invite ..." command, or null when the text is not an invite command. */
export function parseInviteCommand(body: string): { kind: "invite"; phone: string | null } | null {
  const m = /^\s*invite\b[\s:,-]*(.*)$/i.exec(body.trim());
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { kind: "invite", phone: null };
  const e164 = normalizeE164(rest.replace(/[^\d+]/g, "").length === 10 ? `+1${rest.replace(/\D/g, "")}` : rest.replace(/[^\d+]/g, ""));
  return { kind: "invite", phone: e164 };
}

export function inviteCommandApplies(body: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return waitlistConfig(env).enabled && parseInviteCommand(body) !== null;
}

export const INVITE_COPY = {
  needPhone: "Text invite and their number, like: invite 206 555 0100",
  sent: "Invite sent. They can skip the waitlist.",
  limited: "You have sent the most invites for today. Try again tomorrow.",
  failed: "I could not send that invite right now. Try again soon.",
  text: "Hi, a PropLane user invited you. Tap to set up your account:",
} as const;

export async function handleInviteCommand(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; body: string; messageSid: string; origin?: string },
): Promise<string> {
  const parsed = parseInviteCommand(input.body);
  if (!parsed?.phone) return INVITE_COPY.needPhone;
  const limited = await rateLimit(`landlord-invite:${createHash("sha256").update(input.workspaceId).digest("hex").slice(0, 32)}`, INVITES_PER_WORKSPACE_PER_DAY, 24 * 60 * 60 * 1000);
  if (!limited.ok) return INVITE_COPY.limited;
  const minted = await mintSetupLink(db, {
    kind: "landlord",
    phoneKey: normalizeConsentPhone(parsed.phone),
    context: { source: "invite" },
    invitedByWorkspaceId: input.workspaceId,
    origin: input.origin,
  });
  if (!minted.ok) return INVITE_COPY.failed;
  const sent = await sendSharedLineMessage(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    toPhone: parsed.phone,
    body: `${INVITE_COPY.text} ${minted.url} Reply STOP to opt out.`,
    role: "prospect",
    idempotencyKey: `invite:${input.messageSid}`,
  });
  return sent.ok ? INVITE_COPY.sent : INVITE_COPY.failed;
}
