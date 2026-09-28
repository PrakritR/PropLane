import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("vendor work identity UI contract", () => {
  const card = readFileSync("src/components/portal/vendor-work-number-card.tsx", "utf8");
  const settings = readFileSync("src/components/portal/vendor-business-settings.tsx", "utf8");
  it("keeps business contacts separate from account identity and exposes independent channel capability", () => {
    expect(card).toContain("/api/vendor/business-profile");
    expect(card).toContain("/api/vendor/work-identity");
    // Folded onto the identity card's own state line (captain, 2026-09-27) —
    // no more separate "Email · Disabled" / "SMS · Disabled" status cards —
    // but send/receive are still read independently per channel.
    expect(card).toContain("channelCaption");
    expect(card).toContain('sendReady ? "ready" : "unavailable"');
    expect(card).toContain('receiveReady ? "ready" : "unavailable"');
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
