// The prospect burst job stamps the workspace the burst's texts were received for.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: vi.fn() }));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  claimProspectSmsBurst: vi.fn(), completeProspectSmsBurst: vi.fn(),
}));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: vi.fn(), recoverProspectTourBookingForBurst: vi.fn(),
}));

import { loadBurstWorkspaceId } from "@/lib/sms/prospect-sms-burst-job.server";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function fakeDb(opts: {
  receipts?: Array<{ message_sid: string; workspace_id: string | null }>;
  receiptError?: { code: string } | null;
  workspaces?: Array<{ id: string; owner_user_id: string }>;
}) {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        in: (_c: string, v: string[]) => { filters.sids = v; return q; },
        eq: (c: string, v: unknown) => { filters[c] = v; return q; },
        maybeSingle: async () => ({
          data: (opts.workspaces ?? []).find((w) => w.id === filters.id && w.owner_user_id === filters.owner_user_id) ?? null,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve(
          table === "sms_inbound_receipts"
            ? { data: opts.receiptError ? null : (opts.receipts ?? []).filter((r) => (filters.sids as string[]).includes(r.message_sid)), error: opts.receiptError ?? null }
            : { data: [], error: null },
        ),
      };
      return q;
    },
  } as never;
}

describe("loadBurstWorkspaceId", () => {
  const owned = [{ id: WS, owner_user_id: "owner-1" }];

  it("reads the workspace stamped on the claimed receipts and proves the owner holds it", async () => {
    const db = fakeDb({ receipts: [{ message_sid: "SM1", workspace_id: WS }, { message_sid: "SM2", workspace_id: WS }], workspaces: owned });
    expect(await loadBurstWorkspaceId(db, "owner-1", ["SM1", "SM2"])).toBe(WS);
  });

  it("stamps nothing when the workspace is not the owner's, receipts disagree, or nothing is stamped", async () => {
    expect(await loadBurstWorkspaceId(fakeDb({ receipts: [{ message_sid: "SM1", workspace_id: WS }], workspaces: owned }), "owner-2", ["SM1"])).toBeNull();
    expect(await loadBurstWorkspaceId(fakeDb({
      receipts: [{ message_sid: "SM1", workspace_id: WS }, { message_sid: "SM2", workspace_id: OTHER }],
      workspaces: [...owned, { id: OTHER, owner_user_id: "owner-1" }],
    }), "owner-1", ["SM1", "SM2"])).toBeNull();
    expect(await loadBurstWorkspaceId(fakeDb({ receipts: [{ message_sid: "SM1", workspace_id: null }], workspaces: owned }), "owner-1", ["SM1"])).toBeNull();
    expect(await loadBurstWorkspaceId(fakeDb({ workspaces: owned }), "owner-1", [])).toBeNull();
  });

  it("reads a missing column (code before the migration) and a throwing client as no stamp", async () => {
    expect(await loadBurstWorkspaceId(fakeDb({ receiptError: { code: "42703" }, workspaces: owned }), "owner-1", ["SM1"])).toBeNull();
    expect(await loadBurstWorkspaceId({ from: () => { throw new Error("down"); } } as never, "owner-1", ["SM1"])).toBeNull();
  });
});
