import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), resolve: vi.fn(), handle: vi.fn(),
}));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  claimProspectSmsBurst: mocks.claim, completeProspectSmsBurst: mocks.complete,
}));
vi.mock("@/lib/sms/resolve-inbound-original.server", () => ({ resolveInboundOriginal: mocks.resolve }));
vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: mocks.handle }));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: vi.fn(async () => null),
  recoverProspectTourBookingForBurst: vi.fn(),
}));

const ingress = [
  { source_message_id: "SM-first", body: "queued first", received_at: "2026-09-25T12:00:10Z", channel: "twilio" },
  { source_message_id: "SM-second", body: "queued second", received_at: "2026-09-25T12:00:12Z", channel: "twilio" },
];
const burst = { manager_user_id: "owner", counterparty_phone_e164: "+12065552222",
  reply_from_number: "+12065559999", reply_transport: "twilio", shared_catalog: false, channel: "sms" };
function dbFor(rows = ingress, state = burst) {
  return { from(table: string) {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in"]) query[method] = () => query;
    query.maybeSingle = async () => ({ data: table === "prospect_sms_bursts" ? state : null, error: null });
    query.order = async () => ({ data: table === "prospect_sms_ingress" ? rows : [], error: null });
    return query;
  } };
}

describe("prospect SMS burst original hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue({ ok: true, workerId: "worker", sourceIds: ["SM-first", "SM-second"] });
    mocks.complete.mockResolvedValue(true);
    mocks.handle.mockResolvedValue({ ok: true, suppressed: true });
    mocks.resolve.mockImplementation(async (_db: unknown, sid: string) => ({
      sid, ingress: true, role: "prospect", fromPhone: burst.counterparty_phone_e164,
      toPhone: burst.reply_from_number, body: `original ${sid}`,
      occurredAt: sid === "SM-first" ? "2026-09-25T12:00:00Z" : "2026-09-25T12:00:02Z",
    }));
  });

  it("uses each Twilio original in an SMS-channel burst", async () => {
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    const result = await runProspectSmsBurstJob(dbFor() as never, "burst", 3);
    expect(result.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.handle).toHaveBeenCalledWith(expect.objectContaining({ originalMessages: [
      { messageId: "SM-first", body: "original SM-first", receivedAt: "2026-09-25T12:00:00Z" },
      { messageId: "SM-second", body: "original SM-second", receivedAt: "2026-09-25T12:00:02Z" },
    ] }));
  });

  it("keeps original RPC work bounded before model work", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...ingress[0]!, source_message_id: `SM-${i}` }));
    mocks.claim.mockResolvedValue({ ok: true, workerId: "worker", sourceIds: rows.map((row) => row.source_message_id) });
    let active = 0;
    let peak = 0;
    mocks.resolve.mockImplementation(async (_db: unknown, sid: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return { sid, ingress: true, role: "prospect", fromPhone: burst.counterparty_phone_e164,
        toPhone: burst.reply_from_number, body: sid, occurredAt: "2026-09-25T12:00:00Z" };
    });
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    expect((await runProspectSmsBurstJob(dbFor(rows) as never, "burst", 3)).status).toBe(200);
    expect(peak).toBe(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(20);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
  });

  it("fails before model work when one original is unavailable", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("original_missing"));
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    expect((await runProspectSmsBurstJob(dbFor() as never, "burst", 3)).status).toBe(503);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "failed" }));
  });

  it("keeps the retired Claw ingress blocked", async () => {
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    expect((await runProspectSmsBurstJob(dbFor([{ ...ingress[0]!, channel: "claw" }]) as never, "burst", 3)).status).toBe(503);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
