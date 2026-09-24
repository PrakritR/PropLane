import { describe, expect, it } from "vitest";

import {
  assistantMailboxAddress,
  extractAssistantEmailToken,
  extractAssistantMailboxLocal,
  isAssistantEmailAddress,
} from "@/lib/manager-assistant-email/assistant-email-address";

describe("assistant email addressing", () => {
  it("builds shareable addresses on the configured domain (default proplane.ai)", () => {
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
    delete process.env.INBOUND_EMAIL_DOMAIN;
    expect(assistantMailboxAddress("my-workspace")).toBe("my-workspace@proplane.ai");
  });

  it("builds shareable assist-* addresses on an explicit domain", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
    expect(assistantMailboxAddress("assist-jane-smith")).toBe(
      "assist-jane-smith@prop-lane.space",
    );
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("extracts token from legacy plus addressing", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "proplane.ai";
    expect(
      extractAssistantEmailToken(["assistant+mytoken12@proplane.ai", "other@example.com"]),
    ).toBe("mytoken12");
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("extracts readable mailbox local parts", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "proplane.ai";
    expect(
      extractAssistantMailboxLocal(["assist-jane-smith@proplane.ai", "other@example.com"]),
    ).toBe("assist-jane-smith");
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("dual-accepts legacy prop-lane.space on inbound while primary is proplane.ai", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "proplane.ai";
    expect(isAssistantEmailAddress(["assist-jane-smith@prop-lane.space"])).toBe(true);
    expect(isAssistantEmailAddress(["assist-jane-smith@proplane.ai"])).toBe(true);
    expect(isAssistantEmailAddress(["support@proplane.ai"])).toBe(false);
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });

  it("recognizes both legacy and readable assistant addresses", () => {
    process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
    expect(isAssistantEmailAddress(["assistant+tok12345678@prop-lane.space"])).toBe(true);
    expect(isAssistantEmailAddress(["assist-jane-smith@prop-lane.space"])).toBe(true);
    expect(isAssistantEmailAddress(["support@prop-lane.space"])).toBe(false);
    delete process.env.ASSISTANT_EMAIL_DOMAIN;
  });
});
