import { describe, it, expect } from "vitest";
import type { AgentWorkspaceScope } from "@/lib/agent/manager-workspace-scope";
import { makeManagerRowsCtx, makeWritableCtx, previewWrite } from "./fake-agent-ctx";

/**
 * W008: the shared `loadAllManagerRows` LIST loader already applies
 * `rowAllowedInAgentWorkspace` per row (proven for charges/documents/etc. in
 * `workspace-scoped-tool-domains.test.ts`), but four sibling single-record BY
 * ID loaders never propagated that same check: `applications.ts`,
 * `work-orders.ts`, `leases.ts` (two loaders), and `promotions.ts` (both its
 * list AND its single-record loader). A manager with 2+ workspaces asking the
 * assistant to act on a record BY ID could reach one filed under a house in a
 * workspace they are not currently in.
 */

import { getApplicationDetailsTool } from "@/lib/tools/domains/applications";
import { assignVendorTool } from "@/lib/tools/domains/work-orders";
import { voidLeaseTool } from "@/lib/tools/domains/leases";
import { listPromotionsTool, updatePromotionTool } from "@/lib/tools/domains/promotions";

const WS_A: AgentWorkspaceScope = { id: "ws-a", name: "A", isDefault: true, narrowing: true, propertyIds: ["house-a"] };
const WS_B: AgentWorkspaceScope = { id: "ws-b", name: "B", isDefault: false, narrowing: true, propertyIds: ["house-b"] };

describe("get_application_details — refuses an application outside the active workspace", () => {
  function seed() {
    return {
      manager_application_records: [
        {
          id: "app-1",
          manager_user_id: "manager_a",
          resident_email: "pat@example.com",
          row_data: { id: "app-1", name: "Pat", email: "pat@example.com", bucket: "pending", assignedPropertyId: "house-b" },
        },
      ],
    };
  }

  it("cannot see an application outside the active workspace", async () => {
    const ctx = makeManagerRowsCtx(seed(), { workspace: WS_A });
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "app-1" })) as { found: boolean };
    expect(res.found).toBe(false);
  });

  it("can still see an application inside the active workspace", async () => {
    const ctx = makeManagerRowsCtx(seed(), { workspace: WS_B });
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "app-1" })) as { found: boolean };
    expect(res.found).toBe(true);
  });

  it("is unaffected for a single-workspace manager (ctx.workspace undefined)", async () => {
    const ctx = makeManagerRowsCtx(seed(), { workspace: undefined });
    const res = (await getApplicationDetailsTool.handler(ctx, { applicationId: "app-1" })) as { found: boolean };
    expect(res.found).toBe(true);
  });
});

describe("assign_vendor — refuses a work order outside the active workspace", () => {
  function seed() {
    return {
      portal_work_order_records: [
        {
          id: "wo-1",
          manager_user_id: "manager_a",
          vendor_user_id: null,
          row_data: { id: "wo-1", title: "Fix sink", propertyId: "house-b", status: "open" },
        },
      ],
      manager_vendor_records: [
        {
          id: "vendor-1",
          manager_user_id: "manager_a",
          vendor_user_id: null,
          row_data: { id: "vendor-1", name: "Acme Plumbing", trade: "plumbing" },
        },
      ],
    };
  }

  it("cannot see a work order outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_A });
    const result = await previewWrite(assignVendorTool, ctx, { workOrderId: "wo-1", vendorId: "vendor-1" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to this landlord/i) });
  });

  it("can still see a work order inside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    const result = await previewWrite(assignVendorTool, ctx, { workOrderId: "wo-1", vendorId: "vendor-1" });
    expect(result.ok).toBe(true);
  });
});

describe("void_lease — refuses a lease outside the active workspace", () => {
  function seed() {
    return {
      portal_lease_pipeline_records: [
        {
          id: "lease-1",
          manager_user_id: "manager_a",
          property_id: "house-b",
          resident_email: "pat@example.com",
          row_data: { id: "lease-1", residentName: "Pat", unit: "Unit 1", propertyId: "house-b", bucket: "manager", status: "Draft" },
        },
      ],
    };
  }

  it("cannot see a lease outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_A });
    const result = await previewWrite(voidLeaseTool, ctx, { leaseId: "lease-1" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to this landlord/i) });
  });

  it("can still see a lease inside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    const result = await previewWrite(voidLeaseTool, ctx, { leaseId: "lease-1" });
    expect(result.ok).toBe(true);
  });
});

describe("list_promotions / update_promotion — scoped by the active workspace's property ids", () => {
  function seed() {
    return {
      manager_promotion_records: [
        { id: "promo-a", manager_user_id: "manager_a", row_data: { id: "promo-a", propertyId: "house-a", title: "A flyer", template: "modern" } },
        { id: "promo-b", manager_user_id: "manager_a", row_data: { id: "promo-b", propertyId: "house-b", title: "B flyer", template: "modern" } },
      ],
    };
  }

  it("list_promotions shows only workspace A's promotion while A is active", async () => {
    const ctx = makeManagerRowsCtx(seed(), { workspace: WS_A });
    const res = (await listPromotionsTool.handler(ctx, {})) as { promotions: { id: string }[] };
    expect(res.promotions.map((p) => p.id)).toEqual(["promo-a"]);
  });

  it("list_promotions is unaffected for a single-workspace manager", async () => {
    const ctx = makeManagerRowsCtx(seed(), { workspace: undefined });
    const res = (await listPromotionsTool.handler(ctx, {})) as { promotions: { id: string }[] };
    expect(res.promotions.map((p) => p.id).sort()).toEqual(["promo-a", "promo-b"]);
  });

  it("update_promotion cannot reach a promotion outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_A });
    const result = await previewWrite(updatePromotionTool, ctx, { promotionId: "promo-b", title: "New title" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to this landlord/i) });
  });

  it("update_promotion can still reach a promotion inside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_A });
    const result = await previewWrite(updatePromotionTool, ctx, { promotionId: "promo-a", title: "New title" });
    expect(result.ok).toBe(true);
  });
});
