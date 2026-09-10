import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Relay legs carry no owner credit reservation, so the shared SMS transport
 * refuses them. That refusal must surface in logs (thread + leg, never a
 * phone number or the message body) instead of vanishing in a swallowed catch.
 */
const mocks = vi.hoisted(() => ({
  sendSms: vi.fn(),
  notice: vi.fn(async () => undefined),
}));
vi.mock("@/lib/twilio", () => ({
  sendSms: mocks.sendSms,
  normalizeE164: (raw: string) => raw,
}));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => null }));
vi.mock("@/lib/sms-media.server", () => ({ smsMediaAppUrl: (p: string) => p, storeInboundMedia: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-notice.server", () => ({ upsertManagerInboxNotice: mocks.notice }));
vi.mock("@/lib/auth/account-deletion-errors", () => ({ assertAccountCleanupSucceeded: vi.fn() }));
vi.mock("@/lib/auth/load-account-cleanup-rows", () => ({ loadAccountCleanupRows: vi.fn() }));

import { relayInboundSms } from "@/lib/sms-relay.server";

const RESIDENT = "+12065550001";
const MANAGER = "+12065550002";
const PROXY = "+12065550100";

function relayDb() {
  const rows: Record<string, unknown[]> = {
    sms_relay_bindings: [
      { id: "b-res", thread_id: "thread-1", role: "resident", user_id: "res-1", participant_phone: RESIDENT, proxy_phone: PROXY, active: true },
      { id: "b-mgr", thread_id: "thread-1", role: "manager", user_id: "mgr-1", participant_phone: MANAGER, proxy_phone: PROXY, active: true },
    ],
    sms_relay_threads: [{ id: "thread-1", manager_user_id: "mgr-1", counterparty_name: "Res", label: "Unit 1" }],
  };
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
        limit: () => q,
        insert: async () => ({ error: null }),
        maybeSingle: async () => ({ data: (rows[table] ?? []).find((r) => filters.every((f) => f(r as never))) ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r as never))), error: null }).then(resolve),
      };
      return q;
    },
  } as never;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

it("logs a refused relay forward by thread and leg without leaking the phone or body", async () => {
  mocks.sendSms.mockResolvedValue({ sent: false, providerAttempted: false, error: "Use the work-number dispatcher to send messages." });
  const result = await relayInboundSms(relayDb(), { fromPhone: RESIDENT, toPhone: PROXY, body: "the sink is leaking", messageSid: "SM1" });
  expect(result).toMatchObject({ handled: true, managerUserId: "mgr-1" });
  expect(mocks.sendSms).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("sms relay send refused", {
    leg: "forward",
    threadId: "thread-1",
    providerAttempted: false,
    error: "Use the work-number dispatcher to send messages.",
  });
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain(MANAGER);
  expect(logged).not.toContain("sink is leaking");
});

it("logs a thrown transport failure the same way and still finishes the inbound turn", async () => {
  mocks.sendSms.mockRejectedValue(new Error("twilio down"));
  const result = await relayInboundSms(relayDb(), { fromPhone: RESIDENT, toPhone: PROXY, body: "hello", messageSid: "SM2" });
  expect(result).toMatchObject({ handled: true });
  expect(warn).toHaveBeenCalledWith("sms relay send refused", expect.objectContaining({ leg: "forward", threadId: "thread-1", error: "twilio down" }));
  expect(mocks.notice).toHaveBeenCalled();
});

it("stays silent when the relay leg is delivered", async () => {
  mocks.sendSms.mockResolvedValue({ sent: true, sid: "SMx", providerAttempted: true });
  await relayInboundSms(relayDb(), { fromPhone: RESIDENT, toPhone: PROXY, body: "hello", messageSid: "SM3" });
  expect(warn).not.toHaveBeenCalledWith("sms relay send refused", expect.anything());
});
