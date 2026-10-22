/**
 * Rigorous coverage for Claw-primary messaging: CTA deep links, intent
 * classification, and prospect-vs-manager routing helpers.
 */
import { describe, expect, it } from "vitest";
import {
  buildSmsDeepLink,
  classifyLeasingIntent,
  clawLeasingAgentPhoneE164,
  extractPropertyLabelHint,
  isClawSharedLineBridgeEnabled,
  looksLikeProspectLeasingCta,
  managerContactSmsPhoneForPublicCta,
  usableCtaSmsPhone,
  type SmsDeepLinkIntent,
} from "@/lib/claw-leasing-links";
import { replyForIntent } from "@/lib/claw-leasing-bot.server";

const AGENT = "+12053690702";

const CTA_CASES: Array<{
  intent: SmsDeepLinkIntent;
  propertyLabel?: string;
  bundleLabel?: string;
  topic?: string;
  roomName?: string;
  expectBody: string | RegExp;
  expectClassify: ReturnType<typeof classifyLeasingIntent>;
}> = [
  {
    intent: "tour",
    propertyLabel: "The Pioneer",
    expectBody: "Hi — I'd like to schedule a tour for The Pioneer.",
    expectClassify: "tour",
  },
  {
    intent: "tour",
    propertyLabel: "Lakeview Flats",
    expectBody: "Hi — I'd like to schedule a tour for Lakeview Flats.",
    expectClassify: "tour",
  },
  {
    intent: "apply",
    propertyLabel: "The Pioneer",
    expectBody: "Hi — I'd like to apply for The Pioneer.",
    expectClassify: "apply",
  },
  {
    intent: "apply",
    propertyLabel: "Ballard Commons",
    roomName: "Room A",
    expectBody: "Hi — I'd like to apply for Room A at Ballard Commons.",
    expectClassify: "apply",
  },
  {
    intent: "bundle",
    propertyLabel: "The Pioneer",
    bundleLabel: "Listed rooms",
    expectBody: 'Hi — I\'d like to apply for the bundle "Listed rooms" at The Pioneer.',
    expectClassify: "bundle",
  },
  {
    intent: "bundle",
    propertyLabel: "Emerald Court",
    bundleLabel: "Two or more rooms",
    expectBody: 'Hi — I\'d like to apply for the bundle "Two or more rooms" at Emerald Court.',
    expectClassify: "bundle",
  },
  {
    intent: "question",
    propertyLabel: "Cascade Lofts",
    topic: "lease terms",
    expectBody: "Hi — I have a question about lease terms at Cascade Lofts.",
    expectClassify: "question",
  },
  {
    intent: "question",
    propertyLabel: "The Pioneer",
    expectBody: "Hi — I have a question about The Pioneer.",
    expectClassify: "question",
  },
  {
    intent: "lease",
    expectBody: "Hi — I'm ready to review / sign my lease.",
    expectClassify: "lease",
  },
];

const FREEFORM_CASES: Array<{ text: string; intent: ReturnType<typeof classifyLeasingIntent>; cta: boolean }> = [
  { text: "Hey I want more info about 4709a house", intent: "question", cta: true },
  { text: "Is The Pioneer still available?", intent: "question", cta: true },
  { text: "Can I apply for The Pioneer?", intent: "apply", cta: true },
  { text: "Hey I want a tour of the house can you help me", intent: "tour", cta: true },
  { text: "TOUR", intent: "tour", cta: true },
  { text: "APPLY", intent: "apply", cta: true },
  { text: "HELP", intent: "help", cta: true },
  { text: "Hi", intent: "greeting", cta: false },
  { text: "When is my rent due this month?", intent: "question", cta: false },
  { text: "Sure, Saturday at 2 works for them", intent: "question", cta: false },
  { text: "Name: Sam\nEmail: sam@example.com\nSaturday 2pm", intent: "tour_details", cta: true },
];

describe("retired Claw shared-number safeguards", () => {
  it("cannot reactivate the shared agent line through environment flags", () => {
    const prev = process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
    process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = "1";
    expect(isClawSharedLineBridgeEnabled()).toBe(false);
    expect(managerContactSmsPhoneForPublicCta(null)).toBeNull();
    expect(managerContactSmsPhoneForPublicCta("+14258909021")).toBe("+14258909021");
    expect(managerContactSmsPhoneForPublicCta("+12065550199")).toBeNull();
    expect(clawLeasingAgentPhoneE164()).toBe(AGENT);
    // A manager-side CTA, by contrast, needs a number resolved for that listing —
    // the browser never falls back to the shared line on its own.
    expect(usableCtaSmsPhone(undefined)).toBeNull();
    expect(usableCtaSmsPhone(AGENT)).toBeNull();
    if (prev === undefined) delete process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
    else process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = prev;
  });

  it("builds every manager-side CTA deep link to the listing's own resolved number", () => {
    const prev = process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
    process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = "1";

    for (const c of CTA_CASES) {
      const href = buildSmsDeepLink({
        intent: c.intent,
        propertyLabel: c.propertyLabel,
        bundleLabel: c.bundleLabel,
        topic: c.topic,
        roomName: c.roomName,
        // Production hands each listing its own manager's phone.
        toPhone: "+14258909021",
      });
      expect(href.startsWith("sms:+14258909021")).toBe(true);
      const decoded = decodeURIComponent(href.split("body=")[1] ?? "");
      if (typeof c.expectBody === "string") expect(decoded).toBe(c.expectBody);
      else expect(decoded).toMatch(c.expectBody);
      expect(classifyLeasingIntent(decoded)).toBe(c.expectClassify);
      expect(looksLikeProspectLeasingCta(decoded)).toBe(true);
    }

    if (prev === undefined) delete process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED;
    else process.env.NEXT_PUBLIC_CLAW_MESSENGER_ENABLED = prev;
  });

  it("classifies freeform manager/prospect messages for two-way routing", () => {
    for (const c of FREEFORM_CASES) {
      expect(classifyLeasingIntent(c.text), c.text).toBe(c.intent);
      expect(looksLikeProspectLeasingCta(c.text), c.text).toBe(c.cta);
    }
  });

  it("extracts property labels from manager CTA bodies and freeform asks", () => {
    expect(extractPropertyLabelHint("Hi — I'd like to schedule a tour for The Pioneer.")).toBe("The Pioneer");
    expect(extractPropertyLabelHint("Hi — I'd like to apply for The Pioneer.")).toBe("The Pioneer");
    expect(
      extractPropertyLabelHint('Hi — I\'d like to apply for the bundle "Listed rooms" at The Pioneer.'),
    ).toBe("The Pioneer");
    expect(extractPropertyLabelHint("Hey I want more info about 4709a house")).toBe("4709a house");
  });

  it("template replies stay short and link-bearing (domain may still be axis-seattle-housing.com)", () => {
    const origin = "https://www.axis-seattle-housing.com";
    for (const intent of ["tour", "apply", "bundle", "question", "greeting", "unknown"] as const) {
      const reply = replyForIntent({
        intent,
        origin,
        propertyId: "mgr-te-demo-pioneer",
        propertyLabel: "The Pioneer",
        bundleId: intent === "bundle" ? "bun-1" : null,
        phone: "+15105794001",
      });
      // Product name in prose — not the hosting domain.
      expect(reply.toLowerCase()).not.toMatch(/\baxis assistant\b|\baxis housing\b/);
      expect(reply).toContain("/rent/");
      expect(reply.split("\n").length).toBeLessThanOrEqual(6);
    }
  });
});
