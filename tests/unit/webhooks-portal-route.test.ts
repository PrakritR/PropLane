import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveAgentContext,
  rateLimit,
  listWebhookSubscriptions,
  createWebhookSubscription,
  rotateWebhookSecret,
  deleteWebhookSubscription,
  sendTestWebhookEvent,
} = vi.hoisted(() => ({
  resolveAgentContext: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
  listWebhookSubscriptions: vi.fn(),
  createWebhookSubscription: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
  sendTestWebhookEvent: vi.fn(),
}));

vi.mock("@/lib/tools/context", () => ({ resolveAgentContext }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/webhooks/subscriptions.server", () => ({
  listWebhookSubscriptions,
  createWebhookSubscription,
  rotateWebhookSecret,
  deleteWebhookSubscription,
}));
vi.mock("@/lib/webhooks/deliver.server", () => ({ sendTestWebhookEvent }));

import { GET, POST } from "@/app/api/portal/webhooks/route";
import { DELETE, POST as POST_ONE } from "@/app/api/portal/webhooks/[id]/route";

const SUBSCRIPTION = {
  id: "wh_1",
  managerUserId: "manager_1",
  url: "https://hooks.example.com/proplane",
  events: ["work_order.created"],
  enabled: true,
  createdAt: "2026-09-07T00:00:00.000Z",
  disabledAt: null,
  failureCount: 0,
};

const post = (body: unknown) =>
  new Request("https://prop-lane.test/api/portal/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("portal webhooks route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentContext.mockResolvedValue({ userId: "manager_1", db: {} });
    rateLimit.mockReturnValue({ ok: true });
    listWebhookSubscriptions.mockResolvedValue([]);
    createWebhookSubscription.mockResolvedValue({ ok: true, subscription: SUBSCRIPTION, secret: "whsec_plaintext" });
  });

  it("answers 401 to a caller the manager-agent guard rejects", async () => {
    // resolveAgentContext REJECTS non-managers by design — a resident or an
    // anonymous request must never reach the subscription table.
    resolveAgentContext.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect((await POST(post({ url: "https://hooks.example.com/x", events: ["work_order.created"] }))).status).toBe(401);
    expect((await DELETE(new Request("https://prop-lane.test/x", { method: "DELETE" }), { params: Promise.resolve({ id: "wh_1" }) })).status).toBe(401);
    expect((await POST_ONE(post({ action: "rotate" }), { params: Promise.resolve({ id: "wh_1" }) })).status).toBe(401);
    expect(createWebhookSubscription).not.toHaveBeenCalled();
    expect(deleteWebhookSubscription).not.toHaveBeenCalled();
  });

  it("returns the signing secret on create — and never on a later read", async () => {
    const created = await POST(post({ url: "https://hooks.example.com/x", events: ["work_order.created"] }));
    expect(created.status).toBe(201);
    expect((await created.json()).secret).toBe("whsec_plaintext");

    listWebhookSubscriptions.mockResolvedValue([{ ...SUBSCRIPTION, lastDelivery: null }]);
    const listed = await GET();
    const body = await listed.json();
    expect(JSON.stringify(body)).not.toContain("whsec_plaintext");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("shows a rotated secret once, from the rotate call only", async () => {
    rotateWebhookSecret.mockResolvedValue({ subscription: SUBSCRIPTION, secret: "whsec_rotated" });
    const response = await POST_ONE(post({ action: "rotate" }), { params: Promise.resolve({ id: "wh_1" }) });

    expect(await response.json()).toMatchObject({ secret: "whsec_rotated" });
    expect(rotateWebhookSecret).toHaveBeenCalledWith({}, { managerUserId: "manager_1", id: "wh_1" });
  });

  it("scopes every action to the caller, so another manager's id is a 404", async () => {
    rotateWebhookSecret.mockResolvedValue(null);
    deleteWebhookSubscription.mockResolvedValue(false);

    expect((await POST_ONE(post({ action: "rotate" }), { params: Promise.resolve({ id: "someone_else" }) })).status).toBe(404);
    expect(
      (await DELETE(new Request("https://prop-lane.test/x", { method: "DELETE" }), { params: Promise.resolve({ id: "someone_else" }) })).status,
    ).toBe(404);
  });

  it("refuses a create with no allowlisted event", async () => {
    const response = await POST(post({ url: "https://hooks.example.com/x", events: ["lease.signed"] }));
    expect(response.status).toBe(400);
    expect(createWebhookSubscription).not.toHaveBeenCalled();
  });

  it("surfaces the storage layer's URL refusal rather than saving the row", async () => {
    createWebhookSubscription.mockResolvedValue({ ok: false, error: "That host is not reachable from the public internet." });
    const response = await POST(post({ url: "https://127.0.0.1/x", events: ["work_order.created"] }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/public internet/);
  });

  it("sends a test event through the real delivery pipeline", async () => {
    sendTestWebhookEvent.mockResolvedValue({ ok: true, status: 204, error: null });
    const response = await POST_ONE(post({ action: "test" }), { params: Promise.resolve({ id: "wh_1" }) });

    expect(await response.json()).toMatchObject({ ok: true, status: 204 });
    expect(sendTestWebhookEvent).toHaveBeenCalledWith({}, { managerUserId: "manager_1", subscriptionId: "wh_1" });
  });

  it("rejects an unknown action instead of guessing", async () => {
    const response = await POST_ONE(post({ action: "enable" }), { params: Promise.resolve({ id: "wh_1" }) });
    expect(response.status).toBe(400);
  });
});
