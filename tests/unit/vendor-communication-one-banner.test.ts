// captain (studio, 2026-09-27): Vendor Communication shows exactly one setup
// banner (the layout's `VendorMessagingSetupBanner`, never a second one on
// the page itself) and drops the separate "Email · Disabled" / "SMS ·
// Disabled" status cards — that status now lives on the work-identity card's
// own state line instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor Communication — one banner, no separate Disabled status cards", () => {
  it("the vendor layout mounts the messaging setup banner exactly once", () => {
    const layout = read("src/app/vendor/layout.tsx");
    const occurrences = layout.match(/VendorMessagingSetupBanner/g) ?? [];
    // One import + one render call = 2 occurrences of the identifier.
    expect(occurrences.length).toBe(2);
  });

  it("vendor Communication itself never renders a second setup banner", () => {
    const communication = read("src/components/portal/vendor-communication.tsx");
    expect(communication).not.toContain("MessagingSetupBanner");
  });

  it("the work-identity card carries channel status on its own state line, not a separate Email/SMS Disabled card", () => {
    const card = read("src/components/portal/vendor-work-number-card.tsx");
    expect(card).not.toContain("vendor-sending-readiness");
    expect(card).not.toContain('"grid grid-cols-2 gap-2 text-xs"');
    expect(card).toContain("channelCaption");
    expect(card).toContain("noteTone");
    // The work EMAIL card keeps its copy icon; the work number card is retired (vendors never own a number).
    expect(card).not.toContain('"Your work number"');
    expect(card).toContain('"Your work email"');
    expect(card).toContain("copyAction");
  });

  it("vendor Communication still stacks the work-identity cards at the top of the list column", () => {
    const communication = read("src/components/portal/vendor-communication.tsx");
    expect(communication).toContain("VendorWorkNumberCard");
  });
});
