/**
 * Two auth-plumbing regressions found in the end-to-end walkthrough:
 *
 * 1. `?next=` was validated with `startsWith("/")`, which accepts
 *    `//evil.example.com` — a protocol-relative URL that leaves the origin.
 * 2. The portal's background sync loaders kept polling after sign-out, so five
 *    authenticated endpoints 401'd on every cycle for as long as the tab stayed
 *    open.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import {
  markPortalSessionActive,
  markPortalSessionEnded,
  notePortalResponse,
  portalSessionEnded,
} from "@/lib/auth/portal-session-gate";

describe("safeNextPath", () => {
  it("keeps ordinary in-app destinations", () => {
    expect(safeNextPath("/resident/applications/apply?propertyId=mgr-1")).toBe(
      "/resident/applications/apply?propertyId=mgr-1",
    );
    expect(safeNextPath("/portal/dashboard")).toBe("/portal/dashboard");
  });

  it("rejects protocol-relative URLs that leave the origin", () => {
    // The shape the old `startsWith("/")` guard let through.
    expect(safeNextPath("//evil.example.com")).toBeNull();
    expect(safeNextPath("//evil.example.com/portal")).toBeNull();
  });

  it("rejects backslash and scheme smuggling", () => {
    expect(safeNextPath("/\\evil.example.com")).toBeNull();
    expect(safeNextPath("/path\\to")).toBeNull();
    expect(safeNextPath("/javascript:alert(1)")).toBeNull();
  });

  it("rejects absolute URLs and empty input", () => {
    expect(safeNextPath("https://evil.example.com")).toBeNull();
    expect(safeNextPath("evil.example.com")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe("portal session gate", () => {
  beforeEach(() => {
    markPortalSessionActive();
  });

  it("starts open so a signed-in session syncs normally", () => {
    expect(portalSessionEnded()).toBe(false);
  });

  it("latches closed on a 401 so the loaders stop", () => {
    notePortalResponse(401);
    expect(portalSessionEnded()).toBe(true);
  });

  it("ignores non-401 responses — a flaky request is not a sign-out", () => {
    notePortalResponse(200);
    notePortalResponse(500);
    notePortalResponse(404);
    expect(portalSessionEnded()).toBe(false);
  });

  it("reopens on a new sign-in", () => {
    markPortalSessionEnded();
    expect(portalSessionEnded()).toBe(true);
    markPortalSessionActive();
    expect(portalSessionEnded()).toBe(false);
  });
});
