import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";

/**
 * A manager's outbound mail carries their own work email.
 *
 * Every portal email left on one shared `RESEND_FROM`, so a resident or teammate saw
 * "PropLane" regardless of which manager the message concerned, and a reply went to a
 * synthetic address instead of that manager's assistant inbox.
 */

const state = vi.hoisted(() => ({
  assistant: null as { address: string } | null,
  fullName: "" as string | null,
  throwOnLoad: false,
}));

vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  loadManagerAssistantEmail: async () => {
    if (state.throwOnLoad) throw new Error("mailbox table unreachable");
    return state.assistant;
  },
}));

const db = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: state.fullName }, error: null }) }) }),
  }),
} as never;

beforeEach(() => {
  state.assistant = { address: "assist-abc123@prop-lane.space" };
  state.fullName = "Prakrit Ramachandran";
  state.throwOnLoad = false;
});

describe("manager outbound identity", () => {
  it("sends as the manager's name at their work email", async () => {
    expect(await resolveManagerOutboundFrom(db, "mgr-1")).toBe(
      "Prakrit Ramachandran <assist-abc123@prop-lane.space>",
    );
  });

  it("falls back to the bare address when there is no name", async () => {
    state.fullName = "";

    expect(await resolveManagerOutboundFrom(db, "mgr-1")).toBe("assist-abc123@prop-lane.space");
  });

  it("does not let a name break the header", async () => {
    // Angle brackets and quotes in a display name would corrupt the From header; the bare
    // address is correct, where escaping into gibberish would not be.
    state.fullName = 'Ev"il <attacker@evil.test>';

    expect(await resolveManagerOutboundFrom(db, "mgr-1")).toBe("assist-abc123@prop-lane.space");
  });

  it("returns null when the manager has no work email, so the shared sender is used", async () => {
    state.assistant = null;

    expect(await resolveManagerOutboundFrom(db, "mgr-1")).toBeNull();
  });

  it("returns null rather than throwing when the mailbox record cannot be read", async () => {
    // A message must still go out when the identity lookup fails.
    state.throwOnLoad = true;

    expect(await resolveManagerOutboundFrom(db, "mgr-1")).toBeNull();
  });

  it("returns null for a missing manager id", async () => {
    expect(await resolveManagerOutboundFrom(db, "")).toBeNull();
    expect(await resolveManagerOutboundFrom(db, null)).toBeNull();
  });
});
