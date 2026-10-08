// PropLane Number, vendor side: a vendor TEXT from the vendor's own number is paid from the vendor's number credit,
// reserved BEFORE the provider call, handed back when nothing went out, and refused (no provider call) when the
// subscription is inactive or the credit is empty. Email is free. With the flag off none of this runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credit = vi.hoisted(() => ({ reserve: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/number-subscription/credit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/number-subscription/credit.server")>()),
  reserveNumberCredit: credit.reserve,
  finishNumberCredit: credit.finish,
}));
const suppression = vi.hoisted(() => vi.fn());
const shield = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: suppression }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: shield }));
import { deliverVendorWorkIdentity } from "@/lib/vendor-work-identity-delivery.server";

const provider = {
  configured: vi.fn().mockReturnValue(true),
  email: vi.fn().mockResolvedValue({ id: "email-1" }),
  sms: vi.fn().mockResolvedValue({ id: "sms-1" }),
};

function db(opts: { cap?: boolean; claimed?: boolean } = {}) {
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.insert = () => q;
    q.update = () => q;
    q.maybeSingle = async () => ({
      data:
        table === "vendor_work_identity_runtime"
          ? { enabled: true }
          : table === "vendor_work_identity_delivery_attempts"
            ? { id: "attempt" }
            : table === "vendor_work_identity_outbox"
              ? null
              : { id: "i", email_address: "vendor@prop.test", phone_number: "+12065550111", email_state: "ready", sms_state: "ready", email_send_ready: true, sms_send_ready: true, email_domain_verified: true },
      error: null,
    });
    q.then = (r: (v: unknown) => unknown) => r({ error: null });
    return q;
  });
  const rpc = vi.fn((name: string) =>
    Promise.resolve(
      name.includes("operation")
        ? { data: { operation_id: "op", claimed: opts.claimed ?? true }, error: null }
        : opts.cap
          ? { data: { outbox_id: null, blocked_reason: "platform_cap_reached" }, error: null }
          : { data: { outbox_id: "out", claimed: opts.claimed ?? true }, error: null },
    ),
  );
  return { from, rpc } as never;
}

const sms = { vendorUserId: "vendor-1", channel: "sms" as const, recipient: "+12065550000", subject: "Hi", text: "On my way", idempotencyKey: "k1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
  suppression.mockResolvedValue({ ok: true, optedOut: false });
  shield.mockResolvedValue(false);
  credit.reserve.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  credit.finish.mockResolvedValue(undefined);
  provider.configured.mockReturnValue(true);
  provider.sms.mockResolvedValue({ id: "sms-1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("vendor text metering (flag on)", () => {
  it("reserves the segments BEFORE the provider is called and keeps the debit once it is sent", async () => {
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(credit.reserve).toHaveBeenCalledWith("vendor-1", "sms_outbound_segment", 1, "vendor-sms:k1", expect.objectContaining({ metadata: { surface: "vendor_sms" } }));
    expect(credit.reserve.mock.invocationCallOrder[0]).toBeLessThan(provider.sms.mock.invocationCallOrder[0]!);
    expect(credit.finish).toHaveBeenCalledTimes(1);
    expect(credit.finish).toHaveBeenCalledWith("vendor-1", "vendor-sms:k1", expect.objectContaining({ release: false }));
  });

  it("charges every segment of a long text", async () => {
    await deliverVendorWorkIdentity(db(), { ...sms, text: "x".repeat(200) }, provider);
    expect(credit.reserve).toHaveBeenCalledWith("vendor-1", "sms_outbound_segment", 2, "vendor-sms:k1", expect.anything());
  });

  it("an empty credit sends nothing: no provider call, no claim, reason out_of_credit", async () => {
    credit.reserve.mockResolvedValue({ allowed: false, reason: "allowance_exhausted" });
    const x = db();
    const r = await deliverVendorWorkIdentity(x, sms, provider);
    expect(r).toEqual({ ok: false, reason: "out_of_credit" });
    expect(provider.sms).not.toHaveBeenCalled();
    expect((x as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("a lapsed subscription sends nothing: reason subscription_inactive", async () => {
    credit.reserve.mockResolvedValue({ allowed: false, reason: "subscription_inactive" });
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toEqual({ ok: false, reason: "subscription_inactive" });
    expect(provider.sms).not.toHaveBeenCalled();
  });

  it("an unreadable credit ledger is a refusal, never a free send", async () => {
    credit.reserve.mockRejectedValue(new Error("rpc failed"));
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toEqual({ ok: false, reason: "credit_unavailable" });
    expect(provider.sms).not.toHaveBeenCalled();
  });

  it("hands the debit back when the provider definitively rejects the text", async () => {
    provider.sms.mockRejectedValueOnce(new Error("invalid number"));
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toMatchObject({ ok: false, reason: "provider_rejected" });
    expect(credit.finish).toHaveBeenCalledWith("vendor-1", "vendor-sms:k1", expect.objectContaining({ release: true }));
  });

  it("keeps the debit when the outcome is uncertain (the text may have left)", async () => {
    provider.sms.mockRejectedValueOnce(new Error("network timeout"));
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toMatchObject({ ok: false, reason: "provider_outcome_unknown" });
    expect(credit.finish).toHaveBeenCalledWith("vendor-1", "vendor-sms:k1", expect.objectContaining({ release: false }));
  });

  it("hands the debit back when the monthly fair-use cap blocks the send", async () => {
    const r = await deliverVendorWorkIdentity(db({ cap: true }), sms, provider);
    expect(r).toMatchObject({ ok: false, reason: "platform_cap_reached" });
    expect(provider.sms).not.toHaveBeenCalled();
    expect(credit.finish).toHaveBeenCalledWith("vendor-1", "vendor-sms:k1", expect.objectContaining({ release: true }));
  });

  it("refusals that happen before any work (opt-out, quiet hours) reserve nothing", async () => {
    suppression.mockResolvedValue({ ok: true, optedOut: true });
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r.reason).toBe("recipient_opted_out");
    expect(credit.reserve).not.toHaveBeenCalled();
  });

  it("email is free: it never touches the credit", async () => {
    const r = await deliverVendorWorkIdentity(db(), { ...sms, channel: "email", recipient: "r@test.com", idempotencyKey: "k2" }, provider);
    expect(r).toMatchObject({ ok: true });
    expect(credit.reserve).not.toHaveBeenCalled();
    expect(credit.finish).not.toHaveBeenCalled();
  });
});

describe("flag off", () => {
  it("a vendor text is sent exactly as before, with no credit calls at all", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const r = await deliverVendorWorkIdentity(db(), sms, provider);
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(credit.reserve).not.toHaveBeenCalled();
    expect(credit.finish).not.toHaveBeenCalled();
  });
});
