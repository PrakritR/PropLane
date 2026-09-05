import { describe, expect, it } from "vitest";
import {
  isVoiceCallNoteSid,
  voiceCallListPreviewPrefix,
  voiceCallNoteSid,
} from "@/lib/voice/voice-call-notes";

describe("voice call notes", () => {
  it("stamps Communication message sids so the chat can mark them as a call", () => {
    const sid = voiceCallNoteSid({
      callSid: "CAabc123",
      kind: "user",
      digest: "deadbeef",
    });
    expect(sid).toBe("voice:CAabc123:user:deadbeef");
    expect(isVoiceCallNoteSid(sid)).toBe(true);
    expect(isVoiceCallNoteSid("SMnot-a-call")).toBe(false);
    expect(isVoiceCallNoteSid(null)).toBe(false);
  });

  it("uses a Call prefix on the Communication list row", () => {
    expect(voiceCallListPreviewPrefix()).toBe("Call: ");
  });
});
