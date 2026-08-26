import { describe, expect, it } from "vitest";
import { buildPortalRecordShareUrl } from "@/lib/portal-record-share-links.server";

describe("buildPortalRecordShareUrl", () => {
  it("builds lease and application public paths", () => {
    expect(buildPortalRecordShareUrl("https://prop-lane.space", "lease", "abc123")).toBe(
      "https://prop-lane.space/share/leases/abc123",
    );
    expect(buildPortalRecordShareUrl("https://prop-lane.space/", "application", "AXIS-1")).toBe(
      "https://prop-lane.space/share/applications/AXIS-1",
    );
  });
});
