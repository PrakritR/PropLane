import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recover: vi.fn(), envelopes: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/sms/inbound-envelope.server", () => ({ recoverInboundEnvelopes: mocks.envelopes }));
vi.mock("@/lib/sms/process-accepted-inbound.server", () => ({ processAcceptedInbound: vi.fn() }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({ recoverInboundReceipts: mocks.recover }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: mocks.rpc }) }));

import { GET } from "@/app/api/cron/sms-inbound-recovery/route";

function request(secret = "cron-secret") {
  return new Request("https://prop-lane.space/api/cron/sms-inbound-recovery", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.envelopes.mockResolvedValue({ processed: 0, needsReview: 0 });
  mocks.rpc.mockResolvedValue({ error: null });
});

describe("sms inbound recovery cron", () => {
  it("rejects a caller without the cron secret", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("reports failed recoveries as a 503 so the cron run is visible", async () => {
    mocks.recover.mockResolvedValue({ scanned: 2, recovered: 1, failed: 1, dropped: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, scanned: 2, recovered: 1, failed: 1, dropped: 0, envelopes: { processed: 0, needsReview: 0 } });
  });

  it("surfaces uncertain ingress instead of reporting a healthy run", async () => {
    mocks.recover.mockResolvedValue({ scanned: 0, recovered: 0, failed: 0, dropped: 0 });
    mocks.envelopes.mockResolvedValue({ processed: 0, needsReview: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await GET(request())).status).toBe(503);
  });

  it("answers 200 when every due receipt recovered", async () => {
    mocks.recover.mockResolvedValue({ scanned: 1, recovered: 1, failed: 0, dropped: 0 });

    expect((await GET(request())).status).toBe(200);
  });
});
