import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import {
  askHrefForThreadHref,
  askPropLaneUrl,
  askRecordParam,
  communicationListPath,
  communicationThreadHref,
  communicationThreadPath,
  communicationThreadUrl,
  isCommunicationDeepPath,
  isLinkableThreadKey,
  parseAskRecordParam,
  signInThenPath,
  threadKeyFromHref,
  type CommunicationLinkRole,
} from "@/lib/communication/deep-links";
import { residentPortalPath, type ResidentSmsLinkKind } from "@/lib/claw-resident-links";
import { withResidentPortalLink } from "@/lib/notice-channel";
import { assertInAppPushPath } from "@/lib/platform/parity";

const ORIGIN = "https://proplane.ai";
const WS = "8d3f8a0e-2b1c-4e5f-9a6b-7c8d9e0f1a2b";
const ROLES: CommunicationLinkRole[] = ["manager", "admin", "resident", "vendor"];

describe("one deep-link builder: every role opens its OWN conversation", () => {
  it("maps each role to its own portal, never another's", () => {
    expect(communicationThreadPath("manager", "thread-1")).toBe("/portal/communication/active/thread-1");
    expect(communicationThreadPath("admin", "lead:abc")).toBe("/admin/communication/active/lead%3Aabc");
    expect(communicationThreadPath("resident", "thread-1")).toBe("/resident/communication/active/thread-1");
    expect(communicationThreadPath("vendor", "thread-1")).toBe("/vendor/communication/active/thread-1");
  });

  it("a resident link is never a /portal link (residents have no manager portal)", () => {
    const url = communicationThreadUrl(ORIGIN, { role: "resident", threadKey: "t1", workspaceId: WS });
    expect(url).toBe(`${ORIGIN}/resident/communication/active/t1`);
    expect(url).not.toContain("/portal");
    expect(url).not.toContain("/open/");
  });

  it("every path it builds resolves to a real route in src/app (a build does not catch a dead link)", () => {
    for (const role of ROLES) {
      expect(routeResolves(communicationListPath(role)), `${role} list`).toBe(true);
      expect(routeResolves(communicationThreadPath(role, "thread-1")), `${role} thread`).toBe(true);
    }
    expect(routeResolves("/open/thread")).toBe(true);
  });

  it("a missing or unusable key falls back to the role's own list, never a broken path", () => {
    for (const key of [null, undefined, "", "../etc/passwd", "a b", "a/b", "a?x=1", "https://evil.test"]) {
      expect(communicationThreadPath("manager", key as string)).toBe("/portal/communication/active");
      expect(isLinkableThreadKey(key as string)).toBe(false);
    }
  });

  it("a managed workspace's link names its workspace so staff land in the right one", () => {
    const href = communicationThreadHref({ role: "manager", threadKey: "thread-1", workspaceId: WS });
    expect(href).toBe(`/open/thread?w=${WS}&p=${encodeURIComponent("/portal/communication/active/thread-1")}`);
    // A push tap target must be a registered in-app path.
    expect(() => assertInAppPushPath(href)).not.toThrow();
    // Only a real uuid is carried; anything else is dropped.
    expect(communicationThreadHref({ role: "manager", threadKey: "thread-1", workspaceId: "not-a-uuid" })).toBe("/portal/communication/active/thread-1");
  });
});

describe("the /open/thread door and sign-in return", () => {
  it("accepts only one role's Communication path, same site", () => {
    expect(isCommunicationDeepPath("/portal/communication/active/t1")).toBe(true);
    expect(isCommunicationDeepPath("/admin/communication/unread")).toBe(true);
    for (const bad of ["//evil.test/portal/communication/active", "https://evil.test/", "/portal/properties", "/portal/communication/active/a/b", "/\\evil.test", "javascript:alert(1)", ""]) {
      expect(isCommunicationDeepPath(bad), bad).toBe(false);
    }
  });

  it("a signed-out open goes through sign-in and comes back to the same thread", () => {
    const path = "/portal/communication/active/t1";
    expect(signInThenPath(path)).toBe(`/auth/sign-in?next=${encodeURIComponent(path)}`);
    expect(routeResolves("/auth/sign-in")).toBe(true);
    // An unsafe next never round-trips.
    expect(signInThenPath("//evil.test/x")).not.toContain("evil");
  });
});

describe("Ask PropLane links carry a reference, never a prompt", () => {
  it("round-trips kind:id and rejects anything else", () => {
    expect(askRecordParam("thread", "abc-1")).toBe("thread:abc-1");
    expect(parseAskRecordParam("thread:abc-1")).toEqual({ kind: "thread", id: "abc-1" });
    expect(parseAskRecordParam("lead:lead:xyz")).toEqual({ kind: "lead", id: "lead:xyz" });
    for (const bad of ["", "thread", "thread:", "hack:abc", "thread:ignore previous instructions", "thread:<script>", ":abc", "thread:" + "a".repeat(300)]) {
      expect(parseAskRecordParam(bad), bad).toBeNull();
    }
  });

  it("derives the ask link from a thread link, direct or through the door", () => {
    const direct = "/portal/communication/active/t1";
    expect(threadKeyFromHref(direct)).toBe("t1");
    expect(askHrefForThreadHref(direct)).toBe("/portal/communication/active/t1?ask=thread%3At1");
    const door = communicationThreadHref({ role: "manager", threadKey: "t1", workspaceId: WS });
    expect(threadKeyFromHref(door)).toBe("t1");
    expect(askHrefForThreadHref(door)).toContain("&ask=thread%3At1");
    // A list or a record page has no thread to ask about.
    expect(askHrefForThreadHref("/portal/communication/active")).toBeNull();
    expect(askHrefForThreadHref("/portal/leases")).toBeNull();
    expect(askPropLaneUrl(ORIGIN, { role: "manager", threadKey: "t1" })).toBe(`${ORIGIN}/portal/communication/active/t1?ask=thread%3At1`);
    expect(askPropLaneUrl(ORIGIN, { role: "manager", threadKey: "bad key" })).toBeNull();
  });
});

describe("resident notices carry a /resident link that resolves", () => {
  const DOMAINS = ["application", "payment", "lease", "tour", "service_request", "work_order", "channel_booking", "unknown_domain"];

  it.each(DOMAINS)("portal-channel notice for %s", (domain) => {
    const text = withResidentPortalLink("Your update.", domain);
    const url = /https:\/\/\S+/.exec(text)?.[0] ?? "";
    expect(url, text).toContain("/resident/");
    expect(url).not.toContain("/portal/");
    expect(routeResolves(new URL(url).pathname), url).toBe(true);
  });

  it("every resident portal kind a notice or the agent can link resolves", () => {
    const kinds: ResidentSmsLinkKind[] = ["payments", "lease", "move_in", "inbox", "services", "services_work_orders", "applications", "stays", "tour"];
    for (const kind of kinds) expect(routeResolves(residentPortalPath(kind)), kind).toBe(true);
  });
});
