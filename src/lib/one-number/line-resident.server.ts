import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { isHousingSearchText, isPayLinkText } from "@/lib/one-number/line-intent";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { decideFromCandidates } from "@/lib/one-number/router.server";
import { findResidentCandidates, findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { loadSharedLineSession, saveSharedLinePending, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { formatSmsLinks } from "@/lib/sms/link-format";
import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import { residentSendMyLinkTool } from "@/lib/tools/domains/one-number-links";

/**
 * A resident of ANOTHER workspace texts the PropLane line and asks to pay ("send me my rent link"). The line belongs
 * to the PropLane service, not to their landlord, so the work-number resident agent never sees them: they would
 * otherwise be answered as a stranger looking for a house. This answers that one ask, deterministically, with the
 * same phone-bound `/l/<token>` link (and the same texted-code unlock) the work-number resident agent mints:
 *
 *   identity   the VERIFIED phone on a profile, through `resolveResidentSmsAgentContext` bound to the landlord whose
 *              workspace holds their approved residency. That function re-checks verified phone, the resident role
 *              and that this landlord is one of the resident's managers, so a link can only name the resident's own
 *              open charges, for their own workspace, bound to the phone that is texting.
 *   workspace  the one that holds their lease. Several: ask once, remember the answer for the conversation.
 *
 * Anything else a resident says on the line (a housing search, a repair, a lease question) is `handled: false`: the
 * PropLane line keeps answering it exactly as before. Residents of the line owner's own workspace are not here: the
 * work-number resident agent has the same link tool.
 */

export type LineResidentResult = { handled: false } | { handled: true; reply: string; residentUserId: string };

const sessionKey = (phoneKey: string) => `lr:${phoneKey}`;

const candidateOf = (c: SharedLineCandidate): SharedLineCandidate => ({ ...c, role: "resident" });

export async function handleLineResidentText(
  db: SupabaseClient,
  input: { fromPhone: string; body: string; phoneKey: string; lineOwnerUserId: string },
): Promise<LineResidentResult> {
  // Looking for a new place is a prospect's question: the PropLane line answers it from its own catalog.
  if (isHousingSearchText(input.body)) return { handled: false };
  // A pending "which house?" answer ("1", "5259 Brooklyn") carries no pay word of its own.
  const session = await loadSharedLineSession(db, sessionKey(input.phoneKey)).catch(() => null);
  const answering = Boolean(session?.pendingCandidates?.length);
  const payAsk = isPayLinkText(input.body);
  if (!answering && !payAsk) return { handled: false };

  const profile = await findVerifiedProfileByPhone(db, input.fromPhone).catch(() => null);
  if (!profile) return { handled: false };
  const residencies = (await findResidentCandidates(db, input.fromPhone).catch(() => [] as SharedLineCandidate[]))
    .filter((c) => c.ownerUserId !== input.lineOwnerUserId)
    .map(candidateOf);
  if (residencies.length === 0) return { handled: false };
  // An answer to our question only counts when we really asked one (several residencies) and the text is not a new topic.
  if (!payAsk && residencies.length < 2) return { handled: false };

  const decided = decideFromCandidates({ body: input.body, candidates: residencies, session });
  if (decided.kind === "none") return { handled: false };
  if (decided.kind === "ambiguous") {
    await saveSharedLinePending(db, sessionKey(input.phoneKey), decided.candidates);
    return { handled: true, reply: toGsm7(decided.question), residentUserId: profile.id };
  }
  const where = decided.candidate;
  if (residencies.length > 1) await saveSharedLineRoute(db, sessionKey(input.phoneKey), { workspaceId: where.workspaceId, role: "resident" });

  const portal = `${resolveEmailLinkBaseUrl()}${portalSignInHref("/resident/payments")}`;
  const identity = await resolveResidentSmsAgentContext(db, { fromPhone: input.fromPhone, ownerManagerUserId: where.ownerUserId });
  if (!identity.ok) return { handled: false };

  const result = await residentSendMyLinkTool.handler(identity.ctx, { purpose: "rent" });
  if (result.ok) {
    return {
      handled: true,
      residentUserId: profile.id,
      reply: formatSmsLinks(toGsm7(`Here is your secure payment link for ${where.label}: ${result.url} We will text a code to this number when you open it. It works for ${result.expires}.`), resolveEmailLinkBaseUrl()),
    };
  }
  const fallback: Record<string, string> = {
    nothing_to_link: `You have nothing due right now at ${where.label}.`,
    rate_limited: "I have sent you several links already. Try again in an hour.",
    links_unavailable: `I cannot text a payment link right now. You can pay in your PropLane account: ${portal}`,
    not_found: `You have nothing due right now at ${where.label}.`,
  };
  return { handled: true, residentUserId: profile.id, reply: toGsm7(fallback[result.error] ?? fallback.links_unavailable!) };
}
