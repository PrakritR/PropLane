import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineInbound } from "@/lib/one-number/contracts";
import { runDemoTurn } from "@/lib/one-number/demo/run-demo-turn.server";
import { isDemoStartText } from "@/lib/one-number/demo/script";
import { hasLiveDemo } from "@/lib/one-number/demo/store.server";
import { toGsm7, WELCOME } from "@/lib/one-number/lead-qualifying";
import { handleVendorIntake } from "@/lib/one-number/onboarding/vendor-intake.server";
import {
  extractHouseHints,
  inferSenderRole,
  isAccept,
  isDecline,
  mergeHints,
  readRoleAnswer,
  type OnboardingRole,
} from "@/lib/one-number/onboarding/role-detect";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { readOnboardingState, saveOnboardingState, type OnboardingState } from "@/lib/one-number/onboarding/state.server";
import { handleUnassignedLeadInbound, type LeadDeps, type UnassignedLeadTurn } from "@/lib/one-number/unassigned-leads.server";

export const ONBOARDING_COPY = {
  askRole: "Hey! I'm PropLane. Are you looking for a place, renting one out, or a vendor? Reply STOP to opt out.",
  offerDemo: "Want to try me on a sample house first? Reply DEMO. It takes about 2 minutes.",
  reofferDemo: "Reply DEMO to try a sample house, or NO to set up your own properties now.",
  setupNow: "No problem. Set up your own properties here:",
  setupAgain: "Tap to finish setup:",
  setupAgainTail: "Or reply DEMO for the sample house.",
  setupUnavailable: "Setup is not available just now. Reply DEMO to try the sample house, or text me again soon.",
} as const;

export type UnknownSenderTurn = UnassignedLeadTurn & {
  /** Several texts to send in order (the demo's bubbles). `reply` is them joined. */
  replies?: string[];
};

export type UnknownSenderDeps = {
  lead?: LeadDeps;
  now?: () => Date;
  origin?: string;
};

const demoTurn = (replies: string[], leadId: string | null = null): UnknownSenderTurn => ({
  leadId,
  reply: replies.join("\n\n"),
  assignedWorkspaceId: null,
  ...(replies.length > 1 ? { replies } : {}),
});

const single = (text: string): UnknownSenderTurn => ({ leadId: null, reply: toGsm7(text), assignedWorkspaceId: null });

async function hasOpenLead(db: SupabaseClient, phoneKey: string): Promise<boolean> {
  const { data } = await db.from("sms_unassigned_leads").select("id").eq("phone_key", phoneKey).eq("status", "open").maybeSingle();
  return Boolean(data);
}

async function runSmsDemo(db: SupabaseClient, inbound: SharedLineInbound, deps: UnknownSenderDeps): Promise<UnknownSenderTurn | null> {
  const turn = await runDemoTurn(db, { channel: "sms", sessionKey: inbound.phoneKey, text: inbound.body, origin: deps.origin }, { now: deps.now });
  if (!turn.ok) return null;
  if (turn.finished || turn.ended) await saveOnboardingState(db, inbound.phoneKey, { role: "landlord", stage: "finish_sent" }, deps.now?.());
  return demoTurn(turn.messages.map(toGsm7));
}

async function landlordTurn(db: SupabaseClient, inbound: SharedLineInbound, state: OnboardingState | null, firstReply: boolean, deps: UnknownSenderDeps): Promise<UnknownSenderTurn> {
  const now = deps.now?.();
  const hints = mergeHints(state?.hints ?? {}, extractHouseHints(inbound.body));
  const welcome = firstReply ? `${WELCOME} ` : "";

  if (state?.stage === "offered" && isAccept(inbound.body)) {
    const started = await runSmsDemo(db, { ...inbound, body: "DEMO" }, deps);
    if (started) return started;
  }
  const wantsSetup = state?.stage === "finish_sent" || (state?.stage === "offered" && isDecline(inbound.body));
  if (wantsSetup) {
    const minted = await mintSetupLink(db, { kind: "landlord", phoneKey: inbound.phoneKey, context: { ...hints, source: "direct" }, origin: deps.origin, now });
    await saveOnboardingState(db, inbound.phoneKey, { role: "landlord", stage: "finish_sent", hints }, now);
    if (!minted.ok) return single(ONBOARDING_COPY.setupUnavailable);
    return single(state?.stage === "offered" ? `${ONBOARDING_COPY.setupNow} ${minted.url}` : `${ONBOARDING_COPY.setupAgain} ${minted.url} ${ONBOARDING_COPY.setupAgainTail}`);
  }
  if (state?.stage === "offered") {
    await saveOnboardingState(db, inbound.phoneKey, { hints }, now);
    return single(ONBOARDING_COPY.reofferDemo);
  }
  await saveOnboardingState(db, inbound.phoneKey, { role: "landlord", stage: "offered", hints }, now);
  return single(`${welcome}${ONBOARDING_COPY.offerDemo}`);
}

/**
 * Step 7 of the router, in front of W3's lead qualifier: nobody knows this number. Work out who it is
 * (searcher, landlord, vendor), ask ONCE when the first text does not say, then hand the text to the
 * right flow: searchers to the lead qualifier, landlords to the sample-house DEMO and finish-setup
 * link, vendors to the vendor intake. A phone mid-DEMO stays in the sandbox until it finishes or ends.
 * With `sms_onboarding_state` missing (code before the migration) this is exactly the old lead path.
 */
export async function handleUnknownSenderInbound(db: SupabaseClient, inbound: SharedLineInbound, deps: UnknownSenderDeps = {}): Promise<UnknownSenderTurn> {
  const leadPath = () => handleUnassignedLeadInbound(db, inbound, deps.lead);
  const { available, state } = await readOnboardingState(db, inbound.phoneKey);
  if (!available) return leadPath();
  const now = deps.now?.();

  // 1. The sandbox demo: texting DEMO (or the homepage prefill), or already inside one.
  if (isDemoStartText(inbound.body) || (await hasLiveDemo(db, inbound.phoneKey, now))) {
    const hints = mergeHints(state?.hints ?? {}, extractHouseHints(inbound.body));
    if (!state || state.role !== "landlord") await saveOnboardingState(db, inbound.phoneKey, { role: "landlord", stage: "offered", hints }, now);
    const demo = await runSmsDemo(db, inbound, deps);
    if (demo) return demo;
    return single(ONBOARDING_COPY.setupUnavailable);
  }

  // 2. Who is this? A phone with a lead already open (before onboarding existed) is a searcher.
  let role: OnboardingRole | null = state?.role ?? null;
  let firstReply = !state;
  if (!role && !state && (await hasOpenLead(db, inbound.phoneKey))) role = "searcher";
  if (!role) {
    const inferred = inferSenderRole(inbound.body);
    if (inferred) {
      role = inferred;
    } else if (!state?.askedAt) {
      await saveOnboardingState(db, inbound.phoneKey, { askedAt: (now ?? new Date()).toISOString() }, now);
      return single(ONBOARDING_COPY.askRole);
    } else {
      // Asked once already: take the answer, and when it still does not say, a searcher (the default).
      role = readRoleAnswer(inbound.body) ?? "searcher";
      firstReply = false;
    }
    await saveOnboardingState(db, inbound.phoneKey, { role, hints: role === "landlord" ? extractHouseHints(inbound.body) : {} }, now);
    // The ask already carried the STOP notice; an inferred first text has not got one yet.
    if (state?.askedAt) firstReply = false;
  }

  if (role === "landlord") return landlordTurn(db, inbound, state ?? { phoneKey: inbound.phoneKey, role: "landlord", askedAt: null, stage: null, hints: extractHouseHints(inbound.body) }, firstReply, deps);
  if (role === "vendor") {
    const turn = await handleVendorIntake(db, { phoneKey: inbound.phoneKey, body: inbound.body, messageSid: inbound.messageSid, firstReply }, { now: deps.now, origin: deps.origin });
    return { leadId: null, reply: turn.reply, assignedWorkspaceId: null };
  }
  return leadPath();
}
