// @vitest-environment node
import { expect, it, vi } from "vitest";

vi.mock("@/lib/auth/portal-session-gate", () => ({
  onPortalSessionViewerChange: () => { throw new Error("Client reference invoked on server"); },
  notePortalResponse: () => { throw new Error("Client reference invoked on server"); },
  portalSessionEnded: () => { throw new Error("Client reference invoked on server"); },
}));

it("allows server consumers to load pure applicant helpers without calling client references", async () => {
  const { normalizeApplicationAxisId, buildPortalApplicationOpenHref } =
    await import("@/lib/manager-applications-storage");
  expect(normalizeApplicationAxisId("abc123")).toBe("PROPLANE-ABC123");
  expect(buildPortalApplicationOpenHref("PROPLANE-ABC123"))
    .toBe("/portal/applications?open=PROPLANE-ABC123");
});
