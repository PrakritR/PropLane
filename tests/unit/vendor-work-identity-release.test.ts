import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const release = vi.hoisted(() => vi.fn());
vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: release }));
import { releaseQueuedVendorWorkIdentities } from "@/lib/vendor-work-identity-release.server";

function db(rows: Array<{ id: string; phone_number_sid: string | null }>) {
  const writes: unknown[] = [];
  const q: Record<string, unknown> = {};
  q.update = (value: unknown) => { writes.push(value); return q; };
  q.eq = () => q;
  return {
    db: {
      rpc: vi.fn().mockResolvedValue({ data: rows, error: null }),
      from: vi.fn(() => q),
    } as unknown as SupabaseClient,
    writes,
  };
}

describe("vendor work identity release worker", () => {
  it("uses the atomic SQL claim and confirms a release once", async () => {
    release.mockResolvedValue(true);
    const x = db([{ id: "release-1", phone_number_sid: "PN1" }]);
    await expect(releaseQueuedVendorWorkIdentities(x.db)).resolves.toEqual({ released: 1, failed: 0 });
    expect((x.db.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("claim_vendor_work_identity_releases", { p_limit: 20 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(x.writes).toContainEqual(expect.objectContaining({ state: "released" }));
  });

  it("quarantines an ambiguous provider result instead of retrying the SID", async () => {
    release.mockResolvedValue(false);
    const x = db([{ id: "release-1", phone_number_sid: "PN1" }]);
    await expect(releaseQueuedVendorWorkIdentities(x.db)).resolves.toEqual({ released: 0, failed: 1 });
    expect(x.writes).toContainEqual(expect.objectContaining({ state: "reconciling" }));
  });
});
