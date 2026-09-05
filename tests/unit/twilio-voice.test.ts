import { describe, expect, it } from "vitest";
import {
  classifyVoiceConfirmationReply,
  normalizeVoiceConfirmationForAgentGate,
  spokenConsentGranted,
} from "@/lib/voice/voice-confirmation.server";
import {
  escapeXml,
  isManagerVoiceAgentEnabled,
  resolveVoiceTurnWebhookUrl,
  truncateForVoiceSpeech,
  twimlGatherSpeech,
  twimlSay,
} from "@/lib/twilio-voice.server";

describe("voice confirmation", () => {
  it("maps spoken affirmatives to confirm", () => {
    expect(classifyVoiceConfirmationReply("yeah that sounds good")).toBe("confirm");
    expect(classifyVoiceConfirmationReply("no thanks")).toBe("deny");
    expect(normalizeVoiceConfirmationForAgentGate("yeah")).toBe("YES");
    expect(spokenConsentGranted("Yes please")).toBe(true);
  });
});

describe("twilio voice twiml", () => {
  it("escapes xml and builds gather speech", () => {
    expect(escapeXml(`Tom & Jerry's "tour"`)).toBe("Tom &amp; Jerry&apos;s &quot;tour&quot;");
    const say = twimlSay("Hello");
    expect(say).toContain("<Say");
    expect(say).toContain("Hello");
    const gather = twimlGatherSpeech({ actionUrl: "https://example.com/turn", prompt: "Hi" });
    expect(gather).toContain('input="speech"');
    expect(gather).toContain("https://example.com/turn");
  });

  it("truncates long spoken replies", () => {
    const long = "a".repeat(1000);
    expect(truncateForVoiceSpeech(long, 100).length).toBeLessThanOrEqual(100);
  });

  it("honors explicit turn webhook env without duplicating path", () => {
    const prev = process.env.TWILIO_VOICE_TURN_WEBHOOK_URL;
    process.env.TWILIO_VOICE_TURN_WEBHOOK_URL =
      "https://example.com/api/twilio/voice/turn?phase=agent";
    expect(resolveVoiceTurnWebhookUrl("consent")).toBe(
      "https://example.com/api/twilio/voice/turn?phase=consent",
    );
    process.env.TWILIO_VOICE_TURN_WEBHOOK_URL = prev;
  });

  it("reads voice feature flag", () => {
    const prev = process.env.MANAGER_VOICE_AGENT_ENABLED;
    process.env.MANAGER_VOICE_AGENT_ENABLED = "1";
    expect(isManagerVoiceAgentEnabled()).toBe(true);
    process.env.MANAGER_VOICE_AGENT_ENABLED = prev;
  });
});
