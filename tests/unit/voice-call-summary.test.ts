import { describe, expect, it } from "vitest";
import {
  formatVoiceCallSummary,
  type VoiceCallTranscriptLine,
} from "@/lib/voice/voice-call-summary.server";
import {
  MANAGER_NOTIFICATION_CATEGORIES,
  DEFAULT_MANAGER_NOTIFICATION_CATEGORIES,
  managerNotificationCategoryForEvent,
} from "@/lib/manager-notification-preferences";

const TRANSCRIPT: VoiceCallTranscriptLine[] = [
  { direction: "outbound", body: "Call started. What follows is a transcript of this voice call." },
  { direction: "inbound", body: "Is the two bedroom still available?" },
  { direction: "outbound", body: "It is — I can book you a tour." },
];

describe("formatVoiceCallSummary", () => {
  it("names who called for each of the three caller kinds", () => {
    const base = { callerPhone: "+15105791976", workNumber: "+15645652487", transcript: TRANSCRIPT };
    expect(formatVoiceCallSummary({ ...base, callerKind: "manager" }).body).toContain(
      "You called your work number",
    );
    expect(formatVoiceCallSummary({ ...base, callerKind: "resident" }).body).toContain("A resident called");
    expect(formatVoiceCallSummary({ ...base, callerKind: "prospect" }).body).toContain("A prospect called");
  });

  it("includes both sides of the conversation, labelled", () => {
    const { body } = formatVoiceCallSummary({
      callerKind: "prospect",
      callerPhone: "+15105791976",
      workNumber: "+15645652487",
      transcript: TRANSCRIPT,
    });
    expect(body).toContain("Caller: Is the two bedroom still available?");
    expect(body).toContain("PropLane: It is — I can book you a tour.");
  });

  it("says so plainly when a call produced no speech", () => {
    const { body } = formatVoiceCallSummary({
      callerKind: "prospect",
      callerPhone: "+15105791976",
      workNumber: "+15645652487",
      transcript: [],
    });
    expect(body).toContain("No speech was captured");
  });

  it("links to the thread on an absolute origin, never a bare path", () => {
    const { body } = formatVoiceCallSummary({
      callerKind: "resident",
      callerPhone: "+15105791976",
      workNumber: "+15645652487",
      transcript: TRANSCRIPT,
    });
    const link = body.split("Full thread: ")[1]?.trim() ?? "";
    expect(link.startsWith("https://")).toBe(true);
    expect(link.endsWith("/portal/communication")).toBe(true);
  });
});

describe("call summaries are adjustable in Settings", () => {
  it("is offered as its own toggle, so it can be silenced alone", () => {
    expect(MANAGER_NOTIFICATION_CATEGORIES.some((c) => c.id === "voice_calls")).toBe(true);
  });

  it("defaults on — a call has no scrollback to catch up from", () => {
    expect(DEFAULT_MANAGER_NOTIFICATION_CATEGORIES.voice_calls).toBe(true);
  });

  it("maps to its OWN category, not messages — otherwise the toggle is inert", () => {
    // The default branch returns "messages"; without an explicit case, turning
    // call summaries off would silence messages instead and change nothing here.
    expect(managerNotificationCategoryForEvent("voice_calls")).toBe("voice_calls");
  });
});
