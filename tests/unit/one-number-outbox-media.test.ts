// Outbound MMS on the outbox: the enqueue stores only real https media, and degrades before the migration.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cleanOutboundMediaUrls } from "@/lib/sms/owner-sms-dispatcher.server";

describe("cleanOutboundMediaUrls", () => {
  it("keeps https URLs, drops anything else, de-duplicates and caps at 10", () => {
    expect(cleanOutboundMediaUrls(["https://a.test/1.jpg", "http://a.test/2.jpg", "data:image/png;base64,AA", "nope", "https://a.test/1.jpg"]))
      .toEqual(["https://a.test/1.jpg"]);
    const many = Array.from({ length: 14 }, (_, i) => `https://a.test/${i}.jpg`);
    expect(cleanOutboundMediaUrls(many)).toHaveLength(10);
    expect(cleanOutboundMediaUrls(null)).toEqual([]);
    expect(cleanOutboundMediaUrls(undefined)).toEqual([]);
  });
});
