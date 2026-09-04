import { describe, expect, it } from "vitest";

import {
  assistantEmailAddress,
  extractAssistantEmailToken,
  isAssistantEmailAddress,
} from "@/lib/manager-assistant-email/assistant-email-address";

describe("assistant email addressing", () => {
  it("builds assistant+token addresses on the configured domain", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "mail.prop-lane.space";
    expect(assistantEmailAddress("abc123token")).toBe(
      "assistant+abc123token@mail.prop-lane.space",
    );
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("extracts token from plus addressing", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
    expect(
      extractAssistantEmailToken(["assistant+mytoken12@prop-lane.space", "other@example.com"]),
    ).toBe("mytoken12");
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("ignores non-assistant local parts", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
    expect(isAssistantEmailAddress(["payments+tok@prop-lane.space"])).toBe(false);
    expect(isAssistantEmailAddress(["support@prop-lane.space"])).toBe(false);
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });
});
