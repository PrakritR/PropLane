// The credit hold behind a send lives on whichever ledger reserved it. A Free manager on the PropLane Number add-on
// reserves on `number_credit_usage_events`; verifying only the wallet ledger refused every one of their texts (and every
// notice on a PropLane-managed workspace they own) as "Communication credit could not be verified." (prod, Oct 28 - Nov 3).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  walletHold: null as Record<string, unknown> | null,
  numberHold: null as Record<string, unknown> | null,
  walletError: null as { code?: string } | null,
  numberError: null as { code?: string } | null,
  reads: [] as string[],
  numberRow: null as { manager_user_id: string } | null,
  sharedConfigThrows: false,
}));

vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({ messages: { create: mocks.create } }) }));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
vi.mock("@/lib/one-number/shared-line-number.server", () => ({
  isConfiguredSharedNumber: async (_db: unknown, phone: string) => {
    if (mocks.sharedConfigThrows) throw new Error("config unreadable");
    return phone === "+12065550100";
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q, neq: () => q, eq: () => q,
        maybeSingle: async () => {
          mocks.reads.push(table);
          if (table === "manager_sms_numbers") return { data: mocks.numberRow, error: null };
          if (table === "manager_comms_usage_events") return { data: mocks.walletHold, error: mocks.walletError };
          return { data: mocks.numberHold, error: mocks.numberError };
        },
      };
      return q;
    },
  }),
}));

import { sendSms } from "@/lib/twilio";

const OWNER = "00000000-0000-4000-8000-000000000001";
const send = () => sendSms("+12065550142", "hi", "+12065550100", { creditReservationKey: "sms_outbound:abc" });

describe("sendSms verifies the hold on whichever ledger reserved it", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ sid: "SM1" });
    mocks.walletHold = null;
    mocks.numberHold = null;
    mocks.walletError = null;
    mocks.numberError = null;
    mocks.reads = [];
    mocks.numberRow = null;
    mocks.sharedConfigThrows = false;
  });

  it("a wallet / pool hold sends and never touches the number ledger", async () => {
    mocks.walletHold = { manager_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
    await expect(send()).resolves.toMatchObject({ sent: true, sid: "SM1" });
    expect(mocks.reads).not.toContain("number_credit_usage_events");
  });

  it("a PropLane Number add-on hold (owner_user_id, number ledger) sends from the shared line", async () => {
    mocks.numberHold = { owner_user_id: OWNER, meter: "sms_outbound_segment", quantity: "1", credit_state: "reserved" };
    await expect(send()).resolves.toMatchObject({ sent: true, sid: "SM1" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ from: "+12065550100" }));
  });

  it("a number-ledger hold that is not reserved, or has the wrong size, is still refused", async () => {
    mocks.numberHold = { owner_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "released" };
    await expect(send()).resolves.toMatchObject({ sent: false, providerAttempted: false, error: "Communication credit could not be verified." });
    mocks.numberHold = { owner_user_id: OWNER, meter: "sms_outbound_segment", quantity: 3, credit_state: "reserved" };
    await expect(send()).resolves.toMatchObject({ sent: false, providerAttempted: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("no hold on either ledger is refused", async () => {
    await expect(send()).resolves.toMatchObject({ sent: false, providerAttempted: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a database with no number ledger is 'no hold there', and the wallet hold still sends", async () => {
    mocks.walletHold = { manager_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
    mocks.numberError = { code: "42P01" };
    await expect(send()).resolves.toMatchObject({ sent: true });
  });

  it("an unreadable ledger is retried once (a blip does not drop a notice) and then refused, never treated as paid", async () => {
    mocks.walletError = { code: "XX000" };
    await expect(send()).resolves.toMatchObject({ sent: false, providerAttempted: false, error: "Communication credit could not be verified." });
    expect(mocks.reads.filter((t) => t === "manager_comms_usage_events")).toHaveLength(2);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("the shared number that ALSO has a manager_sms_numbers row owned by someone else still sends for the hold owner", async () => {
    mocks.numberRow = { manager_user_id: "00000000-0000-4000-8000-0000000000ff" };
    mocks.walletHold = { manager_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
    await expect(send()).resolves.toMatchObject({ sent: true, sid: "SM1" });
  });

  it("a NON-shared number owned by A with a hold of B is still refused", async () => {
    mocks.numberRow = { manager_user_id: "00000000-0000-4000-8000-0000000000aa" };
    mocks.walletHold = { manager_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
    await expect(sendSms("+12065550142", "hi", "+12065550999", { creditReservationKey: "sms_outbound:abc" })).resolves.toMatchObject({ sent: false, providerAttempted: false, error: "Communication credit could not be verified." });
    mocks.numberRow = { manager_user_id: OWNER };
    await expect(sendSms("+12065550142", "hi", "+12065550999", { creditReservationKey: "sms_outbound:abc" })).resolves.toMatchObject({ sent: true });
  });

  it("an unreadable shared-line config fails closed: the numbers row owner decides, so a different hold owner is refused", async () => {
    mocks.sharedConfigThrows = true;
    mocks.numberRow = { manager_user_id: "00000000-0000-4000-8000-0000000000ff" };
    mocks.walletHold = { manager_user_id: OWNER, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" };
    await expect(send()).resolves.toMatchObject({ sent: false, providerAttempted: false });
  });
});
