/**
 * PropLane messaging first-account texts (client-safe).
 * Resident copy stays natural / human — never “AI assistant” branded.
 */

import { residentGreetingText, residentHelpMenuText } from "@/lib/claw-resident-tone";
import { defaultResidentOnboardingSmsLinks } from "@/lib/claw-resident-links";
import { clawLeasingAgentPhoneE164 } from "@/lib/claw-leasing-links";

/** Resident first-account greeting — sounds like a person, not a bot. */
export function buildResidentPropLaneAssistantIntroSms(opts: {
  name?: string | null;
  axisId?: string | null;
}): string {
  const name = (opts.name ?? "").trim();
  const lines = [
    residentGreetingText(name || null),
    "This is the number for your place — rent, lease, move-in, repairs, that kind of thing.",
    "Just text whenever.",
  ];
  const links = defaultResidentOnboardingSmsLinks();
  lines.push(links.join(" · "));
  const axisId = (opts.axisId ?? "").trim();
  if (axisId) lines.push(`Your account id is ${axisId} if anyone asks.`);
  lines.push("You can reply STOP anytime if you don't want texts.");
  return lines.join("\n");
}

/** Manager first-account / messaging-ready greeting (ops can stay a bit clearer). */
export function buildManagerPropLaneAssistantIntroSms(opts: {
  name?: string | null;
  workNumber?: string | null;
} = {}): string {
  const name = (opts.name ?? "").trim();
  const greeting = name ? `Hi ${name}!` : "Hi!";
  const line = (opts.workNumber ?? "").trim() || clawLeasingAgentPhoneE164();
  return [
    greeting,
    "I'm your PropLane messaging assistant.",
    "I'll text your residents about applications, leases, payments, move-in, and services — and forward their replies here so you can respond from your phone.",
    `Your PropLane line: ${line}`,
    "Prospects and residents text this number directly — no registration needed.",
    "Commands: text AGENT help (e.g. AGENT mark payment for Jane paid, AGENT lease).",
    "Reply STOP anytime to opt out.",
  ].join("\n");
}

// Keep help text import used if callers expect it from onboarding module.
export { residentHelpMenuText };
