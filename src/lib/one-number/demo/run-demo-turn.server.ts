import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceDemo, bubbleToSms, currentPrompt, FINISH_URL_TOKEN, isDemoStartText, startDemo, suggestionsFor, type DemoAdvance } from "@/lib/one-number/demo/script";
import { createDemoSession, loadLiveDemoSession, saveDemoSession } from "@/lib/one-number/demo/store.server";
import { DEMO_WEB_SESSION_PATTERN, type DemoBubble, type DemoState, type DemoTurnInput, type DemoTurnResult } from "@/lib/one-number/demo/types";
import { loadOnboardingState } from "@/lib/one-number/onboarding/state.server";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";

/**
 * ONE demo for both doors: texting DEMO (`channel: "sms"`, session key = the 10-digit phone key) and the
 * homepage "Open the demo" chat (`channel: "web"`, session key = an opaque browser id).
 *
 * Sandbox only. The only rows it writes are `sms_demo_sessions` (the step) and, once the setup questions
 * are done, one `sms_setup_links` row (the finish link). It never reads or writes a real property,
 * resident, vendor, charge, lease, or message row, never alerts a real team, and never bills a workspace.
 * The caller rate-limits (the SMS webhook already does; the web route must).
 */
const SMS_KEY = /^\d{10}$/;

const UNAVAILABLE_LINK = "Setup is not available just now. Text DEMO again in a few minutes and I will send the link.";

function validKey(input: DemoTurnInput): boolean {
  return input.channel === "sms" ? SMS_KEY.test(input.sessionKey) : DEMO_WEB_SESSION_PATTERN.test(input.sessionKey);
}

function result(
  state: DemoState,
  bubbles: DemoBubble[],
  extra: { ended?: boolean; finishUrl?: string | null } = {},
): DemoTurnResult {
  return {
    ok: true,
    bubbles,
    messages: bubbles.map(bubbleToSms),
    step: state.step,
    finished: state.step === "finished",
    ended: extra.ended ?? state.step === "ended",
    finishUrl: extra.finishUrl ?? null,
    suggestions: suggestionsFor(state.step),
  };
}

/** Mint the finish link and write its URL into the bubble that carries the placeholder. */
async function withFinishLink(
  db: SupabaseClient,
  input: DemoTurnInput,
  advance: DemoAdvance,
  now: Date,
): Promise<{ bubbles: DemoBubble[]; url: string | null }> {
  const minted = await mintSetupLink(db, {
    kind: "landlord",
    phoneKey: input.channel === "sms" ? input.sessionKey : null,
    context: { ...advance.state.hints, source: "demo" },
    origin: input.origin,
    now,
  });
  const url = minted.ok ? minted.url : null;
  const bubbles = advance.bubbles.map((b) => (b.text.includes(FINISH_URL_TOKEN) ? { ...b, text: url ? b.text.replace(FINISH_URL_TOKEN, url) : UNAVAILABLE_LINK } : b));
  return { bubbles, url };
}

export async function runDemoTurn(db: SupabaseClient, input: DemoTurnInput, deps: { now?: () => Date } = {}): Promise<DemoTurnResult> {
  if (!validKey(input)) return { ok: false, reason: "invalid_session" };
  const now = (deps.now ?? (() => new Date()))();
  const text = (input.text ?? "").trim().slice(0, 500);
  const live = await loadLiveDemoSession(db, input.channel, input.sessionKey, now);

  // A new demo: nothing live, or the user asked to start over. On the web any first turn starts it.
  if (!live || (text && isDemoStartText(text))) {
    const known = input.channel === "sms" ? await loadOnboardingState(db, input.sessionKey) : null;
    const begin = startDemo(known?.hints ?? {});
    const session = await createDemoSession(db, { channel: input.channel, sessionKey: input.sessionKey, state: begin.state, now });
    if (!session) return { ok: false, reason: "unavailable" };
    return result(begin.state, begin.bubbles);
  }

  if (!text) return result(live.state, currentPrompt(live.state));

  const advance = advanceDemo(live.state, text);
  if (advance.finish) {
    const { bubbles, url } = await withFinishLink(db, input, advance, now);
    await saveDemoSession(db, live.id, advance.state, now, { finish: true });
    return result(advance.state, bubbles, { finishUrl: url });
  }
  await saveDemoSession(db, live.id, advance.state, now, { finish: advance.ended });
  return result(advance.state, advance.bubbles, { ended: advance.ended });
}
