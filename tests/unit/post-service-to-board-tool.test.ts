// post_service_to_board: the assistant's path onto the public work board, with the route's authorization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { postServiceToBoardTool } from "@/lib/tools/domains/service-board";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { CO_MANAGER_SCOPED_TOOLS, scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";
import { FIND_WORK_TRADE_OPTIONS } from "@/lib/vendor-find-work";
import { publicBoardServiceProjection, publicServiceTradeLabel } from "@/lib/public-service-projection";
import { workOrderCategoryForMarketplace } from "@/lib/work-order-marketplace-match.server";
import { categoriesForVendorTrade } from "@/lib/work-order-taxonomy";
import type { AgentContext } from "@/lib/tools/context";
import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";

const MANAGER = "mgr-1";
const service = (id: string, owner: string, rowData: Row = {}): Row => ({
  id, manager_user_id: owner, vendor_user_id: null, test_workspace_id: null,
  row_data: {
    id, title: "Kitchen sink leak", description: "Slow leak.", category: "plumbing", propertyName: "Alder House",
    propertyAddress: "1420 Alder St, Seattle, WA 98115", unit: "4B", residentName: "SECRET RESIDENT", status: "Open", bucket: "pending",
    ...rowData,
  },
});

let db: ReturnType<typeof createFakeDb>;
const ctxFor = (overrides: Partial<AgentContext> = {}) =>
  ({ landlordId: MANAGER, userId: MANAGER, email: "m@x.test", roles: ["manager"], isAdmin: false, db, ...overrides }) as unknown as AgentContext;
const rowOf = (id: string) => db.tables.portal_work_order_records!.find((r) => r.id === id)!.row_data as Row;

beforeEach(() => {
  db = createFakeDb({
    audit_log: [],
    work_order_bids: [],
    portal_work_order_records: [
      service("wo-1", MANAGER),
      service("wo-tour", MANAGER, { title: "Tour host for Saturday showings", category: undefined }),
      service("wo-clean", MANAGER, { title: "Turnover clean", category: "cleaning" }),
      service("wo-theirs", "mgr-2"),
    ],
  });
});

describe("post_service_to_board", () => {
  it("previews only what goes public: trade, title, general area, never the street or resident", async () => {
    const preview = await postServiceToBoardTool.preview(ctxFor(), { workOrderId: "wo-1" });
    const text = JSON.stringify(preview);
    expect(preview.fields).toContainEqual({ label: "Board category", value: "Plumbing" });
    expect(text).not.toContain("1420 Alder");
    expect(text).not.toContain("SECRET RESIDENT");
    expect(rowOf("wo-1").published).toBeUndefined();
  });

  it("publishes through publishServiceToBoard and opens bidding", async () => {
    const result = await postServiceToBoardTool.handler(ctxFor(), { workOrderId: "wo-1" });
    expect(result).toMatchObject({ reply: expect.stringContaining("work board") });
    expect(rowOf("wo-1")).toMatchObject({ published: true, biddingOpen: true });
    expect(String(rowOf("wo-1").publishRef)).toMatch(/^pub_/);
  });

  it("refuses another workspace's service in preview and handler, and writes nothing", async () => {
    await expect(postServiceToBoardTool.preview(ctxFor(), { workOrderId: "wo-theirs" })).rejects.toThrow(/belongs to this landlord/);
    await expect(postServiceToBoardTool.handler(ctxFor(), { workOrderId: "wo-theirs" })).rejects.toThrow(/belongs to this landlord/);
    expect(rowOf("wo-theirs").published).toBeUndefined();
  });

  it("refuses a service that is no longer open", async () => {
    db.tables.portal_work_order_records![0]!.vendor_user_id = "vendor-9";
    await expect(postServiceToBoardTool.preview(ctxFor(), { workOrderId: "wo-1" })).rejects.toThrow(/open service/);
  });

  it("a tour-host job publishes with the Tours category", async () => {
    const preview = await postServiceToBoardTool.preview(ctxFor(), { workOrderId: "wo-tour" });
    expect(preview.fields).toContainEqual({ label: "Board category", value: "Tours" });
    await postServiceToBoardTool.handler(ctxFor(), { workOrderId: "wo-tour" });
    expect(rowOf("wo-tour").category).toBe("tours");
    const view = publicBoardServiceProjection(rowOf("wo-tour") as never, "Alder Property Co");
    expect(view?.trade).toBe("Tours");
  });

  it("an explicit category override is stored", async () => {
    await postServiceToBoardTool.handler(ctxFor(), { workOrderId: "wo-1", category: "tours" });
    expect(rowOf("wo-1").category).toBe("tours");
  });

  it("Cleaning and Tours are board categories everywhere the board lists them", async () => {
    await postServiceToBoardTool.handler(ctxFor(), { workOrderId: "wo-clean" });
    expect(publicServiceTradeLabel(rowOf("wo-clean").category as never)).toBe("Cleaning");
    const labels = FIND_WORK_TRADE_OPTIONS.map((o) => o.label);
    expect(labels).toContain("Cleaning");
    expect(labels).toContain("Tours");
    expect(categoriesForVendorTrade("Cleaning")).toEqual(["cleaning"]);
    expect(categoriesForVendorTrade("Tours")).toEqual(["tours"]);
    expect(workOrderCategoryForMarketplace({}, "Tour host")).toBe("tours");
  });
});

describe("post_service_to_board authorization parity and registries", () => {
  const access = (over: Partial<ManagerSmsAccess>) => ({ mode: "owner", readOnly: false, ...over }) as ManagerSmsAccess;

  it("a delegated actor is refused: not scoped, not in the delegated registry, wrapper refuses", async () => {
    expect(CO_MANAGER_SCOPED_TOOLS.has("post_service_to_board")).toBe(false);
    expect(buildManagerSmsRegistry(access({ mode: "delegated" })).has("post_service_to_board")).toBe(false);
    const delegated = ctxFor({ landlordId: "owner-7", userId: MANAGER, managerSmsAccess: access({ mode: "delegated" }) });
    const scoped = scopeManagerTool(postServiceToBoardTool);
    if (scoped.kind !== "write") throw new Error("write expected");
    await expect(scoped.preview(delegated, { workOrderId: "wo-1" })).rejects.toThrow();
    await expect(postServiceToBoardTool.handler(delegated, { workOrderId: "wo-1" })).rejects.toThrow(/another manager/);
    expect(rowOf("wo-1").published).toBeUndefined();
  });

  it("is a non-destructive write on the portal and manager SMS registries, absent for a read-only seat", () => {
    const tool = agentRegistry.get("post_service_to_board");
    expect(tool?.kind).toBe("write");
    expect(tool?.kind === "write" && tool.destructive).toBeFalsy();
    expect(buildManagerSmsRegistry().has("post_service_to_board")).toBe(true);
    expect(buildManagerSmsRegistry(access({ readOnly: true })).has("post_service_to_board")).toBe(false);
  });
});
