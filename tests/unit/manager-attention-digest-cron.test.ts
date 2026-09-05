import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceClient, deliverDigest } = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  deliverDigest: vi.fn().mockResolvedValue({ sent: true, summary: { total: 4 } }),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceClient }));
vi.mock("@/lib/manager-attention-digest.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-attention-digest.server")>();
  return { ...actual, deliverManagerAttentionDigest: deliverDigest };
});

describe("manager attention digest cron", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://prop-lane.space");
  });

  it("rejects an invalid cron secret", async () => {
    const { GET } = await import("@/app/api/cron/manager-attention-digest/route");
    const response = await GET(new Request("https://prop-lane.space/api/cron/manager-attention-digest"));
    expect(response.status).toBe(401);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("delivers opted-in daily digests and skips off preferences", async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [
        { manager_user_id: "manager-daily", digest_cadence: "daily" },
        { manager_user_id: "manager-off", digest_cadence: "off" },
      ],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ select });
    serviceClient.mockReturnValue({ from });

    const { GET } = await import("@/app/api/cron/manager-attention-digest/route");
    const response = await GET(
      new Request("https://prop-lane.space/api/cron/manager-attention-digest", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    const body = (await response.json()) as { sent: number; skipped: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ sent: 1, skipped: 1 });
    expect(deliverDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: "manager-daily",
        cadence: "daily",
        portalUrl: "https://prop-lane.space/portal",
      }),
    );
  });
});
