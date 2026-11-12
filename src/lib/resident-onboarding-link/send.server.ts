import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneBoundLink, PhoneBoundLinkError, revokePhoneBoundLinksForTarget } from "@/lib/one-number/links.server";
import { sendWorkspaceText, type WorkspaceTextResult } from "@/lib/one-number/link-text.server";
import { rateLimit } from "@/lib/rate-limit";
import { firstNameOf, ONBOARDING_TARGET_TYPE, onboardingLinkText, onboardingTargetId, type OnboardingSourceKind } from "./model";
import { loadOnboardingFacts, type OnboardingFactsResult } from "./sources.server";

export const ONBOARDING_LINK_PURPOSE = "move_in" as const;
/** The text consent purposes the gate reads: an applicant's own rental-application opt-in covers them (never invented here). */
export const ONBOARDING_LINK_SMS_PURPOSE = "resident_onboarding_link";
export const ONBOARDING_WELCOME_SMS_PURPOSE = "resident_onboarding_welcome";

export type SendOnboardingLinkResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_ready" | "no_phone" | "unreadable" | "rate_limited" | "send_failed" | "not_consented"; detail?: string };

export type SendOnboardingLinkDeps = {
  facts?: (input: { workspaceId: string; kind: OnboardingSourceKind; id: string }) => Promise<OnboardingFactsResult>;
  mint?: typeof mintPhoneBoundLink;
  send?: (input: Parameters<typeof sendWorkspaceText>[1]) => Promise<WorkspaceTextResult>;
  allow?: (key: string) => Promise<boolean>;
  now?: () => Date;
};

/**
 * "Text onboarding link": ONE text to the phone on an approved application or a confirmed booking, carrying ONE
 * link that opens a one-time-code gate and then the one-or-two-screen onboarding.
 *
 *  - the recipient is the phone on the manager's OWN record in THIS workspace (re-derived here; a request names only
 *    the record id), never a number from the request;
 *  - the link is the phone-bound link service (token hashed at rest, bound to that phone, OTP required, single use,
 *    14 days); a resend replaces the earlier link, so exactly one is live;
 *  - the text goes from the workspace's own line (`sendWorkspaceText`: the work number, or the PropLane line for a
 *    managed workspace) behind the ordinary consent and STOP gates; a refusal revokes the link it just made;
 *  - at most two sends per record per ten minutes.
 */
export async function sendOnboardingLink(
  db: SupabaseClient,
  input: { workspaceId: string; kind: OnboardingSourceKind; id: string; actorUserId: string },
  deps: SendOnboardingLinkDeps = {},
): Promise<SendOnboardingLinkResult> {
  const loaded = await (deps.facts ?? ((i) => loadOnboardingFacts(db, i)))({ workspaceId: input.workspaceId, kind: input.kind, id: input.id });
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const { facts } = loaded;

  const allowed = await (deps.allow ?? (async (key: string) => (await rateLimit(key, 2, 10 * 60 * 1000)).ok))(`onboarding-link:${facts.kind}:${facts.id}`);
  if (!allowed) return { ok: false, reason: "rate_limited" };

  const targetId = onboardingTargetId(facts.kind, facts.id);
  let minted: Awaited<ReturnType<typeof mintPhoneBoundLink>>;
  try {
    minted = await (deps.mint ?? mintPhoneBoundLink)(db, {
      phoneKey: facts.phoneKey,
      workspaceId: facts.workspaceId,
      purpose: ONBOARDING_LINK_PURPOSE,
      targetType: ONBOARDING_TARGET_TYPE,
      targetId,
      createdBy: input.actorUserId,
      now: deps.now?.(),
    });
  } catch (error) {
    if (error instanceof PhoneBoundLinkError && error.code === "rate_limited") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "unreadable" };
  }

  const send = deps.send ?? ((i) => sendWorkspaceText(db, i));
  const sent = await send({
    workspaceId: facts.workspaceId,
    phoneKey: facts.phoneE164,
    body: onboardingLinkText({ firstName: firstNameOf(facts.fullName), houseLabel: facts.houseLabel, url: minted.url }),
    role: "resident",
    idempotencyKey: `onboarding-link:${minted.linkId}`,
    propertyId: facts.propertyId,
    basis: {
      kind: "resident_notice",
      purpose: ONBOARDING_LINK_SMS_PURPOSE,
      sendClass: "transactional",
      recipientUserId: facts.residentUserId,
      recipientEmail: facts.email || null,
    },
  }).catch((): WorkspaceTextResult => ({ ok: false, error: "provider_error" }));
  if (!sent.ok) {
    // A link nobody received must not stay live.
    await revokePhoneBoundLinksForTarget(db, { targetType: ONBOARDING_TARGET_TYPE, targetId, purpose: ONBOARDING_LINK_PURPOSE }).catch(() => 0);
    const reason = sent.error && /consent/i.test(sent.error) ? "not_consented" : "send_failed";
    return { ok: false, reason, detail: sent.error };
  }
  return { ok: true };
}
