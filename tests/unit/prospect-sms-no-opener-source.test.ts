import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sent = vi.hoisted(() => ({ calls: [] as { to: string; body: string; from: string }[] }));
vi.mock("@/lib/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twilio")>()),
  sendSms: vi.fn(async (to: string, body: string, from: string) => {
    sent.calls.push({ to, body, from });
    return { sent: true as const, providerAttempted: true as const };
  }),
}));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({}) }));

import { provisionRelayThread } from "@/lib/sms-relay.server";
import {
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestManagerSms,
  buildTourRequestRemovedTenantBody,
  buildTourRequestTenantBody,
} from "@/lib/tour-notifications";

/** Only the rows `provisionRelayThread` reads: the thread count, the allocated number, the thread and its bindings. */
function relayDb() {
  return {
    rpc: async () => ({ data: "num-1", error: null }),
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        insert: () => q,
        delete: () => q,
        maybeSingle: async () =>
          table === "sms_relay_numbers"
            ? { data: { id: "num-1", phone_e164: "+12065550111" }, error: null }
            : { data: null, error: null },
        single: async () => ({ data: { id: "thread-1" }, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null, count: 0 }).then(resolve),
      };
      return q;
    },
  } as never;
}

describe("prospect-facing SMS sources carry no PropLane opener and no STOP footer", () => {
  beforeEach(() => {
    sent.calls = [];
  });

  // The relay's intro is the first text a resident or prospect gets on a new proxy number, built and sent by
  // `provisionRelayThread`. Oracle: docs/agents/sms-system.md - the person hears from the home ("your direct
  // line"), while the "PropLane:" opener and the STOP/HELP footer belong to PropLane's own alert to staff.
  // Wrong behaviour this rejects: that opener or footer growing onto the counterparty's copy.
  it("the sms-relay intro: the counterparty hears about their direct line, with no platform opener", async () => {
    const result = await provisionRelayThread(relayDb(), {
      managerUserId: "mgr-1",
      managerPhone: "+12065550100",
      managerName: "Akshaya",
      counterpartyPhone: "+12065552222",
      label: "5257 Brooklyn",
    });
    expect(result.ok).toBe(true);
    const intro = sent.calls.find((call) => call.to === "+12065552222")?.body ?? "";
    expect(intro).toContain("direct line");
    expect(intro).toContain("5257 Brooklyn");
    expect(intro).not.toMatch(/PropLane:|Reply STOP|HELP for help/);
  });

  // docs/agents/sms-system.md: a prospect hears from the home, not from the platform — the "PropLane:" opener and the
  // STOP/HELP footer belong to PropLane's own alert to the manager. Wrong behaviour this rejects: a guest notice that
  // opens "PropLane:" or carries a compliance footer meant for the staff alert.
  it("the tour texts: the manager's alert opens with PropLane, the guest's copy never does", () => {
    const ctx = buildTourNotificationContext({
      origin: "https://proplane.ai",
      guestName: "QA Test Prospect",
      guestEmail: "qa@example.com",
      propertyId: "prop-5257",
      propertyTitle: "5257 Brooklyn",
      tourStartIso: "2026-11-21T22:00:00.000Z",
      tourEndIso: "2026-11-21T22:30:00.000Z",
      tourInquiryId: "inq-1",
    });
    const managerAlert = buildTourRequestManagerSms(ctx);
    expect(managerAlert.startsWith("PropLane: ")).toBe(true);
    expect(managerAlert).not.toMatch(/Reply STOP|HELP for help/);
    for (const guestCopy of [
      buildTourRequestTenantBody(ctx),
      buildTourConfirmedTenantBody(ctx),
      buildTourCanceledTenantBody(ctx, "The host is away"),
      buildTourRequestRemovedTenantBody(ctx),
    ]) {
      expect(guestCopy.startsWith("PropLane:")).toBe(false);
      expect(guestCopy).not.toMatch(/PropLane: |Reply STOP|HELP for help/);
    }
  });
});
