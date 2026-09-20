import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("vendor work identity UI contract", () => {
  const card = readFileSync("src/components/portal/vendor-work-number-card.tsx", "utf8");
  const settings = readFileSync("src/components/portal/vendor-business-settings.tsx", "utf8");
  it("keeps business contacts separate from account identity and exposes independent channel capability", () => {
    expect(card).toContain("/api/vendor/business-profile");
    expect(card).toContain("/api/vendor/work-identity");
    expect(card).toContain("Send {capability(\"email\")?.sendReady");
    expect(card).toContain("Receive {capability(\"sms\")?.receiveReady");
    expect(settings).toContain("Free · covered by PropLane");
  });
  it("renders disabled, unavailable, capacity, failed-read and retry states", () => {
    for (const source of [card, settings]) {
      expect(source).toContain("provider_disabled");
      expect(source).toContain("provider_unconfigured");
      expect(source).toContain("platform_capacity_reached");
      expect(source).toContain("Retry");
    }
  });
});
