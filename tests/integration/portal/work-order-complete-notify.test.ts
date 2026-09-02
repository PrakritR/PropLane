import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

// complete/route.ts gates on getReportsAuthContext + assertManagerFinancialsAccess,
// mirroring manager-documents.test.ts's mocking of the auth layer directly.
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(),
  assertManagerFinancialsAccess: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn().mockResolvedValue({ ok: true, recipientCount: 1 }),
}));

import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { POST } from "@/app/api/portal/work-orders/complete/route";

type WorkOrderStoreRow = { id: string; manager_user_id?: string; row_data: Record<string, unknown> };

function mockDb(seed: WorkOrderStoreRow[]) {
  const store = new Map(seed.map((r) => [r.id, r]));
  const upserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (table === "portal_work_order_records") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: store.get(id) ?? null, error: null }),
            }),
          }),
          upsert: async (rec: Record<string, unknown>) => {
            upserts.push(rec);
            store.set(rec.id as string, { id: rec.id as string, row_data: rec.row_data as Record<string, unknown> });
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts };
}

function asManager(userId: string, client: unknown) {
  vi.mocked(getReportsAuthContext).mockResolvedValue({
    role: "manager",
    userId,
    email: "mgr@test.com",
    db: client as never,
  } as never);
  vi.mocked(assertManagerFinancialsAccess).mockResolvedValue({ ok: true });
}

describe("POST /api/portal/work-orders/complete resident notify", () => {
  beforeEach(() => vi.clearAllMocks());

  it("notifies the resident once on first completion", async () => {
    const { client } = mockDb([]);
    asManager("mgr-1", client);

    const res = await POST(
      jsonRequest("http://t", {
        method: "POST",
        body: {
          workOrder: { id: "WO-1", title: "Leaky faucet", residentEmail: "res@test.com", propertyName: "Elm House" },
          category: "plumbing",
        },
      }),
    );
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(200);
    expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverPortalInboxMessage).mock.calls[0]![1]).toMatchObject({
      subject: "Leaky faucet completed",
      toEmails: ["res@test.com"],
    });
  });

  it("does not notify again on a retried completion (completedAt already set)", async () => {
    const { client } = mockDb([
      {
        id: "WO-2",
        // The completion route gates on ownership (`existing.manager_user_id !==
        // auth.userId` is a 403), so a seeded row has to carry the owner column
        // a real row would, or a retried completion is refused rather than
        // being the no-op this test is about.
        manager_user_id: "mgr-1",
        row_data: {
          id: "WO-2",
          title: "Leaky faucet",
          residentEmail: "res@test.com",
          completedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    ]);
    asManager("mgr-1", client);

    const res = await POST(
      jsonRequest("http://t", {
        method: "POST",
        body: {
          workOrder: { id: "WO-2", title: "Leaky faucet", residentEmail: "res@test.com" },
          category: "plumbing",
        },
      }),
    );
    const { status } = await parseJsonResponse(res);

    expect(status).toBe(200);
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });
});
