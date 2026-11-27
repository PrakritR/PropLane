import { describe, expect, it } from "vitest";

import { twilioErrorText } from "@/lib/twilio";

describe("twilioErrorText", () => {
  it("puts Twilio's numeric code where the outbox can read it", () => {
    const error = Object.assign(new Error("Authenticate"), { code: 20003, status: 401 });
    const text = twilioErrorText(error);
    expect(text).toBe("20003: Authenticate");
    expect(text.match(/\b\d{5}\b/)?.[0]).toBe("20003");
  });

  it("leaves a message that already names its code, and plain errors, alone", () => {
    expect(twilioErrorText(Object.assign(new Error("Error 21610 opted out"), { code: 21610 }))).toBe("Error 21610 opted out");
    expect(twilioErrorText(new Error("socket hang up"))).toBe("socket hang up");
    expect(twilioErrorText("boom")).toBe("boom");
  });
});
