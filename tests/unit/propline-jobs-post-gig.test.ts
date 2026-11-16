// post_gig: the price is read by code from the manager's words, the home is re-derived from THEIR records, and a posting is a
// service on the existing services system, published to the board and offered by text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
const fanOutGigOffers = vi.fn(async () => ({ considered: 3, sent: 2, skipped: {} }));
vi.mock("@/lib/jobs/gig-offers.server", () => ({ fanOutGigOffers: (...a: unknown[]) => (fanOutGigOffers as (...x: unknown[]) => unknown)(...a) }));

import { postGigTool } from "@/lib/tools/domains/gig-post";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";

const MANAGER = "mgr-1";
const property = (id: string, owner: string, address: string, extra: Row = {}): Row => ({ id, manager_user_id: owner, status: "live", row_data: { title: address, address, zip: "98115", ...extra } });

let db: ReturnType<typeof createFakeDb>;
const ctx = (over: Partial<AgentContext> = {}) => ({ landlordId: MANAGER, userId: MANAGER, email: "m@x.test", roles: ["manager"], isAdmin: false, db, ...over }) as unknown as AgentContext;

beforeEach(() => {
  fanOutGigOffers.mockClear();
  db = createFakeDb({
    audit_log: [],
    work_order_bids: [],
    gig_posts: [],
    portal_work_order_records: [],
    manager_property_records: [
      property("p-4709a", MANAGER, "4709A 8th Ave NE, Seattle, WA"),
      property("p-5257", MANAGER, "5257 Brooklyn Ave NE, Seattle, WA"),
      property("p-theirs", "mgr-2", "4709 Other St, Seattle, WA"),
    ],
  });
});

describe("post_gig preview", () => {
  it("reads the price, kind, time and room from the words and shows them back", async () => {
    const preview = await postGigTool.preview(ctx(), { request: "need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40" });
    const text = JSON.stringify(preview);
    expect(preview.fields).toContainEqual({ label: "You will pay", value: "$40" });
    expect(preview.fields).toContainEqual({ label: "Job", value: "Tour showing" });
    expect(preview.fields).toContainEqual({ label: "When", value: "Saturday 2pm" });
    expect(text).toContain("Room 3");
    expect(text).toContain("Not the address");
  });

  it("refuses a request with no price, two prices, or an absurd one - nothing is guessed", async () => {
    await expect(postGigTool.preview(ctx(), { request: "need my rooms cleaned at 5257 this week" })).rejects.toThrow(/no price/);
    await expect(postGigTool.preview(ctx(), { request: "clean 5257 for $100 or $150" })).rejects.toThrow(/more than one price/);
    await expect(postGigTool.preview(ctx(), { request: "clean 5257 for $90,000" })).rejects.toThrow(/between/);
  });

  it("re-derives the home from the manager's own records: another manager's id and street are refused", async () => {
    await expect(postGigTool.preview(ctx(), { request: "show it, $40", propertyId: "p-theirs" })).rejects.toThrow(/not one of this landlord/);
    await expect(postGigTool.preview(ctx(), { request: "need someone to show 4709 Saturday, I'll pay $40" })).rejects.toThrow(/Which home/);
  });

  it("is not available to a delegated co-manager", async () => {
    await expect(postGigTool.preview(ctx({ userId: "co-1" }), { request: "show 4709A, $40", propertyId: "p-4709a" })).rejects.toThrow(/another manager's account/);
  });
});

describe("post_gig execute", () => {
  it("creates a priced service in the existing services system, publishes it with the price, and offers it by text", async () => {
    const result = await postGigTool.handler(ctx(), { request: "need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40" });
    const service = db.tables.portal_work_order_records![0]!;
    const row = service.row_data as Row;
    expect(service.manager_user_id).toBe(MANAGER);
    expect(row).toMatchObject({ category: "tours", status: "Open", bucket: "open", published: true, publishBudgetCents: 4000, propertyId: "p-4709a", biddingOpen: true });
    expect(row.vendorId).toBeUndefined();
    expect(service.vendor_user_id ?? null).toBeNull();
    const gig = db.tables.gig_posts![0]!;
    expect(gig).toMatchObject({ manager_user_id: MANAGER, kind: "tour_showing", offered_cents: 4000, source: "sms" });
    expect(String(gig.code)).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(fanOutGigOffers).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain("$40");
    expect(result.reply).toContain("I texted 2 nearby vendors");
    expect(result.reply).toContain(String(service.id));
  });

  it("a cleaning posts under Cleaning; a repeat the same day posts nothing new", async () => {
    await postGigTool.handler(ctx(), { request: "I need my rooms cleaned at 5257 this week, $120" });
    expect((db.tables.portal_work_order_records![0]!.row_data as Row).category).toBe("cleaning");
    expect((db.tables.gig_posts![0]!.window_text as string)).toBe("This week");
    expect(db.tables.gig_posts![0]!.kind).toBe("cleaning");
    await postGigTool.handler(ctx(), { request: "I need my rooms cleaned at 5257 this week, $120" });
    // The same posting returns the earlier service (and the audit dedupe key refuses it in the real table): nothing new, no second round of texts.
    expect(db.tables.portal_work_order_records).toHaveLength(1);
    expect(db.tables.gig_posts).toHaveLength(1);
    expect(fanOutGigOffers).toHaveBeenCalledTimes(1);
    expect(((db.tables.gig_posts![0]) as Row).code).toBeTruthy();
  });

  it("never lets a model-supplied price through: the schema has no amount field and the text decides", () => {
    expect(Object.keys((postGigTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(["kind", "propertyId", "request", "roomLabel"]);
  });
});

describe("surfaces", () => {
  it("is a confirmed (non-destructive) write on the portal assistant and manager SMS, and not on a delegated seat", () => {
    expect(postGigTool.kind).toBe("write");
    expect((postGigTool as { destructive?: boolean }).destructive).not.toBe(true);
    expect(agentRegistry.has("post_gig")).toBe(true);
    expect(buildManagerSmsRegistry().has("post_gig")).toBe(true);
    expect(buildManagerSmsRegistry({ mode: "delegated" } as never).has("post_gig")).toBe(false);
  });
});
