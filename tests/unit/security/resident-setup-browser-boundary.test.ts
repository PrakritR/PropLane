import { describe, expect, it, vi } from "vitest";

// A browser-facing URL/email helper must never initialize the server token module.
// This fails at import time if a transitive dependency reconnects that boundary.
vi.mock("@/lib/auth/resident-setup-token", () => {
  throw new Error("Server token/identity code reached the browser helper graph.");
});

import { buildResidentSetupHref, residentSetupAccountUrl, residentSetupIdFromUrlParams } from "@/lib/auth/resident-setup-links";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";

describe("browser-safe resident setup links", () => {
  it("preserves new and legacy ID query compatibility without loading server encryption", () => {
    expect(residentSetupIdFromUrlParams(new URLSearchParams("proplane_id=AXIS-NEW&axis_id=AXIS-OLD"))).toBe("AXIS-NEW");
    expect(residentSetupIdFromUrlParams(new URLSearchParams("axis_id=AXIS-OLD"))).toBe("AXIS-OLD");
    expect(residentSetupIdFromUrlParams(new URLSearchParams())).toBe("");
    expect(buildResidentSetupHref(" token+/= ", "AXIS-1")).toBe("/auth/resident-setup?token=token%2B%2F%3D&proplane_id=PROPLANE-1");
    expect(residentSetupAccountUrl("https://example.test/", "token", "AXIS-1")).toBe("https://example.test/auth/resident-setup?token=token&proplane_id=PROPLANE-1");
  });
  it("keeps the shared welcome-email helper usable by browser mailto flows", () => {
    expect(residentAccountCreationUrl("https://example.test", "AXIS-1", "token")).toContain("/auth/resident-setup?token=token&proplane_id=PROPLANE-1");
  });
});
