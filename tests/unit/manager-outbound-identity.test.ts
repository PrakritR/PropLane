import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fromHeaderAddress,
  fromHeaderDisplayName,
  managerOutboundFromHeader,
  resolveManagerOutboundFrom,
  sharedPortalFromAddress,
} from "@/lib/manager-outbound-identity.server";

/**
 * A manager's outbound mail carries the WORKSPACE work email with their own name on it.
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
  resolveWorkspaceWorkEmail: async () => {
    if (state.throwOnLoad) throw new Error("mailbox table unreachable");
    return state.assistant ? { ownerUserId: "owner-1", ownerName: "Owner", address: state.assistant.address } : null;
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

  it("the From header is the work email when the workspace has one", async () => {
    expect(await managerOutboundFromHeader(db, "mgr-1")).toBe(
      "Prakrit Ramachandran <assist-abc123@prop-lane.space>",
    );
  });

  it("the From header falls back to the shared sender when there is no work email", async () => {
    state.assistant = null;
    vi.stubEnv("RESEND_FROM", "PropLane <noreply@prop-lane.space>");
    expect(await managerOutboundFromHeader(db, "mgr-1")).toBe("PropLane <noreply@prop-lane.space>");
    expect(sharedPortalFromAddress()).toBe("PropLane <noreply@prop-lane.space>");
    vi.unstubAllEnvs();
  });

  it("parses the display name and address from a From header", () => {
    expect(fromHeaderDisplayName("Prakrit Ramachandran <assist-abc123@prop-lane.space>")).toBe(
      "Prakrit Ramachandran",
    );
    expect(fromHeaderAddress("Prakrit Ramachandran <assist-abc123@prop-lane.space>")).toBe(
      "assist-abc123@prop-lane.space",
    );
    expect(fromHeaderAddress("assist-abc123@prop-lane.space")).toBe("assist-abc123@prop-lane.space");
  });
});

describe("manager-originated product mail leaves on the work email", () => {
  const originated = [
    "src/lib/lead-invite.server.ts",
    "src/lib/vendor-invite.server.ts",
    "src/lib/vendor-notification-delivery.ts",
    "src/lib/resident-welcome.server.ts",
    "src/lib/tour-notification-delivery.server.ts",
    "src/lib/property-lead-prospect-handoff.server.ts",
    "src/lib/tools/domains/payments.ts",
    "src/lib/resident-apply-invite-email.ts",
    "src/app/api/cron/send-payment-reminders/route.ts",
    "src/app/api/portal/send-payment-reminder/route.ts",
    "src/app/api/portal/scheduled-messages/[id]/send-now/route.ts",
    "src/app/api/portal/send-application-completion-reminder/route.ts",
    "src/app/api/portal/send-lead-invite/route.ts",
    "src/app/api/portal/record-share-link/send/route.ts",
  ];

  it("every manager-to-counterparty sender resolves the workspace From header", () => {
    for (const file of originated) {
      expect(readFileSync(file, "utf8"), file).toContain("managerOutboundFromHeader");
    }
  });

  it("conversation mail still prefers the workspace address, then the shared sender", () => {
    const send = readFileSync("src/lib/portal-email-send.server.ts", "utf8");
    expect(send).toContain("sharedPortalFromAddress");
    expect(send).toMatch(/opts\.fromAddress\?\.trim\(\)\s*\|\|\s*sharedPortalFromAddress\(\)/);
  });

  it("the automated spine still delivers through the inbox layer", () => {
    expect(readFileSync("src/lib/reminders/dispatch.server.ts", "utf8")).toContain("deliverPortalInboxMessage");
    expect(readFileSync("src/lib/portal-inbox-delivery.ts", "utf8")).toContain("resolveManagerOutboundFrom");
  });
});
