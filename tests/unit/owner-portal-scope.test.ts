/**
 * Owner portal (W21): every owner read is scoped to the owner's OWN houses, narrowed to one of their own workspaces by the
 * switcher, and carries no resident, vendor or ledger-line field. Nothing in a request names an owner or a manager.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const managed: { workspaceId: string; workspaceName: string }[] = [];
vi.mock("@/lib/owner-management/policies.server", () => ({
  listManagedWorkspacesForOwner: vi.fn(async () => managed),
}));
const financeViews = new Map<string, unknown>();
vi.mock("@/lib/managed-finance/finances.server", () => ({
  loadOwnerFinances: vi.fn(async (_db: unknown, _stripe: unknown, input: { workspaceId: string }) => financeViews.get(input.workspaceId)),
  loadOwnerMonthlyChart: vi.fn(async (_db: unknown, input: { months: string[] }) =>
    input.months.map((month, i) => ({ month, incomeCents: i === input.months.length - 1 ? 215_000 : 0, expensesCents: i === input.months.length - 1 ? 21_500 : 0 })),
  ),
}));

import { narrowGrantsToWorkspace, ownerWorkspaceKey, type OwnerGrant } from "@/lib/property-owner/access.server";
import { loadOwnerOverviewExtras } from "@/lib/property-owner/overview.server";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { loadOwnerPropertyDetail, ownerCostCents, ownerPhotoUrls } from "@/lib/property-owner/property-detail.server";
import { OwnerScopeError } from "@/lib/property-owner/summary.server";
import { loadOwnerWorkspaces } from "@/lib/property-owner/workspaces.server";
import { withOwnerWorkspace } from "@/components/owner/owner-data";
import { pickOwnerWorkspace } from "@/components/owner/owner-workspace";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const OWNER = "owner-1";
const house = (propertyId: string) => ({ propertyId, performance: true, statements: true, documents: true, messages: false });
const grants: OwnerGrant[] = [
  { linkId: "link-a", workspaceId: "ws-a", managerUserId: MANAGER, houses: [house("alder"), house("maple")] },
  { linkId: "link-b", workspaceId: "ws-b", managerUserId: MANAGER, houses: [house("lake")] },
  { linkId: "link-old", workspaceId: "", managerUserId: MANAGER, houses: [house("legacy")] },
];

beforeEach(() => {
  managed.length = 0;
  financeViews.clear();
});

describe("workspace narrowing", () => {
  it("keeps only the grants of the workspace named, and an unknown key is empty (a 404 at the route)", () => {
    expect(narrowGrantsToWorkspace(grants, "ws-a").map((g) => g.linkId)).toEqual(["link-a"]);
    expect(narrowGrantsToWorkspace(grants, "ws-other")).toEqual([]);
    expect(narrowGrantsToWorkspace(grants, "").length).toBe(3);
    expect(narrowGrantsToWorkspace(grants, undefined).length).toBe(3);
  });

  it("names a legacy membership with no workspace by its own membership id", () => {
    expect(ownerWorkspaceKey(grants[0]!)).toBe("ws-a");
    expect(ownerWorkspaceKey(grants[2]!)).toBe("link:link-old");
    expect(narrowGrantsToWorkspace(grants, "link:link-old").map((g) => g.linkId)).toEqual(["link-old"]);
  });

  it("is added to every owner read except the lists that mean 'mine'", () => {
    expect(withOwnerWorkspace("/api/owner/summary", "ws-a")).toBe("/api/owner/summary?workspace=ws-a");
    expect(withOwnerWorkspace("/api/owner/summary?propertyId=x", "ws-a")).toBe("/api/owner/summary?propertyId=x&workspace=ws-a");
    expect(withOwnerWorkspace("/api/owner/finances", "ws-a")).toBe("/api/owner/finances");
    expect(withOwnerWorkspace("/api/owner/finances?workspace=ws-b&month=2026-10", "ws-a")).toBe("/api/owner/finances?workspace=ws-b&month=2026-10");
    expect(withOwnerWorkspace("/api/owner/workspaces", "ws-a")).toBe("/api/owner/workspaces");
    expect(withOwnerWorkspace("/api/other", "ws-a")).toBe("/api/other");
    expect(withOwnerWorkspace("/api/owner/summary", null)).toBe("/api/owner/summary");
  });

  it("starts on the remembered workspace only while it is still the owner's", () => {
    const tiles = [
      { id: "ws-a", label: "A", houses: 2, managed: true },
      { id: "ws-b", label: "B", houses: 1, managed: false },
    ];
    expect(pickOwnerWorkspace(tiles, "ws-b")).toBe("ws-b");
    expect(pickOwnerWorkspace(tiles, "ws-gone")).toBe("ws-a");
    expect(pickOwnerWorkspace(tiles, null)).toBe("ws-a");
    expect(pickOwnerWorkspace([], "ws-a")).toBeNull();
  });
});

describe("workspace tiles", () => {
  it("lists only the owner's own workspaces, names from the workspace row, managed from the policy", async () => {
    managed.push({ workspaceId: "ws-a", workspaceName: "Alder Row Homes" });
    const db = makeFakeDb({
      portal_workspaces: [
        { id: "ws-a", name: "Alder Row Homes" },
        { id: "ws-b", name: "Lakeview Rentals" },
        { id: "ws-stranger", name: "Someone Else's" },
      ],
    });
    const tiles = await loadOwnerWorkspaces(db, OWNER, grants.slice(0, 2));
    expect(tiles).toEqual([
      { id: "ws-a", label: "Alder Row Homes", houses: 2, managed: true },
      { id: "ws-b", label: "Lakeview Rentals", houses: 1, managed: false },
    ]);
    expect(JSON.stringify(tiles)).not.toContain("Someone Else");
    expect(() => assertOwnerPayloadRedacted(tiles)).not.toThrow();
  });

  it("drops a membership that reaches no house and survives a policy read failure", async () => {
    const { listManagedWorkspacesForOwner } = await import("@/lib/owner-management/policies.server");
    vi.mocked(listManagedWorkspacesForOwner).mockRejectedValueOnce(new Error("boom"));
    const db = makeFakeDb({ portal_workspaces: [{ id: "ws-a", name: "A" }] });
    const tiles = await loadOwnerWorkspaces(db, OWNER, [{ ...grants[0]!, houses: [] }, grants[1]!]);
    expect(tiles.map((t) => t.id)).toEqual(["ws-b"]);
    expect(tiles[0]!.managed).toBe(false);
  });
});

describe("overview extras", () => {
  const view = (pending: { id: string; title: string; amountCents: number }[]) => ({
    statement: { totals: { rentGrossCents: 215_000, feeCents: -21_500, netCents: 193_500 } },
    balance: { availableCents: 150_000 },
    pendingApprovals: pending.map((p) => ({ ...p, workspaceId: "ws-a", vendorLabel: "Top Roofing", propertyId: null, requestedAt: "2026-10-10T00:00:00Z" })),
  });

  it("reports fee, net and available for a managed workspace in scope, and the repairs waiting on the owner", async () => {
    managed.push({ workspaceId: "ws-a", workspaceName: "A" });
    financeViews.set("ws-a", view([{ id: "exp-1", title: "Roof patch", amountCents: 40_000 }]));
    const db = makeFakeDb({ owner_statements: [], managed_workspace_fee_policies: [], resident_inspections: [] });
    const out = await loadOwnerOverviewExtras(db, OWNER, grants.slice(0, 1), new Date("2026-10-18T12:00:00Z"));
    expect(out.managed).toEqual({ workspaceId: "ws-a", rentCents: 215_000, feeCents: -21_500, netCents: 193_500, availableCents: 150_000 });
    // The chart reads the same ledger as the cards: twelve Pacific months ending now, the current one carrying the rent.
    expect(out.managedChart).toHaveLength(12);
    expect(out.managedChart?.at(-1)).toEqual({ month: "2026-10", incomeCents: 215_000, expensesCents: 21_500 });
    expect(out.attention).toEqual([{ kind: "repair", id: "exp-1", title: "Roof patch", amountCents: 40_000, workspaceId: "ws-a" }]);
    // The vendor is never named to the owner.
    expect(JSON.stringify(out)).not.toContain("Top Roofing");
    expect(() => assertOwnerPayloadRedacted(out)).not.toThrow();
  });

  it("leaves the money out when the workspace in scope is not managed", async () => {
    managed.push({ workspaceId: "ws-a", workspaceName: "A" });
    financeViews.set("ws-a", view([]));
    const db = makeFakeDb({ owner_statements: [], managed_workspace_fee_policies: [], resident_inspections: [] });
    const out = await loadOwnerOverviewExtras(db, OWNER, [grants[1]!], new Date("2026-10-18T12:00:00Z"));
    expect(out.managed).toBeNull();
    expect(out.managedChart).toBeNull();
    expect(out.attention).toEqual([]);
  });

  it("lists a fresh statement and an agreement to sign, only for workspaces in scope", async () => {
    const db = makeFakeDb({
      owner_statements: [
        { id: "s1", workspace_id: "ws-a", month_key: "2026-09", created_at: "2026-10-10T00:00:00Z" },
        { id: "s2", workspace_id: "ws-stranger", month_key: "2026-09", created_at: "2026-10-10T00:00:00Z" },
        { id: "s3", workspace_id: "ws-a", month_key: "2026-06", created_at: "2026-07-01T00:00:00Z" },
      ],
      managed_workspace_fee_policies: [
        { id: "p1", workspace_id: "ws-a", owner_user_id: OWNER, status: "draft", sent_at: "2026-10-01T00:00:00Z" },
        { id: "p2", workspace_id: "ws-a", owner_user_id: "someone-else", status: "draft", sent_at: "2026-10-01T00:00:00Z" },
      ],
      resident_inspections: [],
    });
    const out = await loadOwnerOverviewExtras(db, OWNER, grants.slice(0, 1), new Date("2026-10-18T12:00:00Z"));
    expect(out.attention).toEqual([
      { kind: "statement", id: "s1", month: "2026-09", workspaceId: "ws-a" },
      { kind: "agreement", id: "p1", workspaceId: "ws-a" },
    ]);
  });

  it("lists upcoming move-ins and move-outs of the owner's own houses only, with no resident field", async () => {
    const db = makeFakeDb({
      owner_statements: [],
      managed_workspace_fee_policies: [],
      resident_inspections: [
        { id: "i1", property_id: "alder", property_label: "Alder Row", room_label: "Room 3", kind: "move-in", inspection_date: "2026-10-23", resident_name: "Maya Chen" },
        { id: "i2", property_id: "not-mine", property_label: "Elsewhere", room_label: "Room 1", kind: "move-out", inspection_date: "2026-10-24", resident_name: "Other Person" },
        { id: "i3", property_id: "maple", property_label: "Maple Court", room_label: "Room 2", kind: "move-out", inspection_date: "2026-12-30" },
      ],
    });
    const out = await loadOwnerOverviewExtras(db, OWNER, grants.slice(0, 1), new Date("2026-10-18T12:00:00Z"));
    expect(out.upcoming).toEqual([{ id: "i1", kind: "move-in", date: "2026-10-23", house: "Alder Row", unit: "Room 3" }]);
    expect(JSON.stringify(out)).not.toContain("Maya");
    expect(JSON.stringify(out)).not.toContain("Elsewhere");
  });

  it("treats a missing table as nothing there", async () => {
    const db = makeFakeDb(
      {},
      { errors: { owner_statements: { message: "no table", code: "42P01" }, managed_workspace_fee_policies: { message: "no table", code: "42P01" }, resident_inspections: { message: "no table", code: "42P01" } } },
    );
    const out = await loadOwnerOverviewExtras(db, OWNER, grants.slice(0, 1));
    expect(out).toEqual({ managed: null, managedChart: null, attention: [], upcoming: [] });
  });
});

describe("house detail", () => {
  const db = () =>
    makeFakeDb({
      manager_property_records: [
        {
          id: "alder",
          manager_user_id: MANAGER,
          property_data: {
            listingSubmission: {
              housePhotoDataUrls: ["https://cdn.example.test/a.jpg", "data:image/png;base64,AAAA", "/relative.jpg", "https://cdn.example.test/a.jpg"],
              rooms: [{ photoDataUrls: ["https://cdn.example.test/r1.jpg"] }],
            },
          },
        },
        { id: "not-mine", manager_user_id: MANAGER, property_data: { listingSubmission: { housePhotoDataUrls: ["https://cdn.example.test/secret.jpg"] } } },
      ],
      portal_work_order_records: [
        { id: "wo1", manager_user_id: MANAGER, property_id: "alder", created_at: "2026-10-06T00:00:00Z", row_data: { title: "Kitchen sink leak", bucket: "completed", cost: "$240", scheduledAtIso: "2026-10-06T17:00:00Z", residentName: "Maya Chen", vendorName: "Pipes Co" } },
        { id: "wo2", manager_user_id: MANAGER, property_id: "alder", created_at: "2026-10-07T00:00:00Z", row_data: { title: "", bucket: "open" } },
        { id: "wo3", manager_user_id: MANAGER, property_id: "not-mine", created_at: "2026-10-07T00:00:00Z", row_data: { title: "Someone else's repair", bucket: "open" } },
      ],
    });

  it("returns real https photos once each and the services history without a resident or vendor", async () => {
    const out = await loadOwnerPropertyDetail(db(), grants, "alder");
    expect(out.photos).toEqual(["https://cdn.example.test/a.jpg", "https://cdn.example.test/r1.jpg"]);
    expect(out.services).toEqual([{ id: "wo1", title: "Kitchen sink leak", stage: "completed", date: "2026-10-06", costCents: 24_000 }]);
    expect(JSON.stringify(out)).not.toMatch(/Maya|Pipes/);
    expect(() => assertOwnerPayloadRedacted(out)).not.toThrow();
  });

  it("refuses a house the owner was not granted exactly like one that does not exist", async () => {
    await expect(loadOwnerPropertyDetail(db(), grants, "not-mine")).rejects.toBeInstanceOf(OwnerScopeError);
    await expect(loadOwnerPropertyDetail(db(), grants, "nope")).rejects.toBeInstanceOf(OwnerScopeError);
    // A house of ANOTHER workspace is out of reach once the switcher narrowed to this one.
    await expect(loadOwnerPropertyDetail(db(), narrowGrantsToWorkspace(grants, "ws-b"), "alder")).rejects.toBeInstanceOf(OwnerScopeError);
  });

  it("never invents a photo: no listing photos is an empty list", () => {
    expect(ownerPhotoUrls({})).toEqual([]);
    expect(ownerPhotoUrls({ listingSubmission: { housePhotoDataUrls: ["data:image/png;base64,AAAA"] } })).toEqual([]);
  });

  it("reads a cost label as cents and refuses anything that is not an amount", () => {
    expect(ownerCostCents("$1,250.50")).toBe(125_050);
    expect(ownerCostCents(45)).toBe(4_500);
    expect(ownerCostCents("TBD")).toBeNull();
    expect(ownerCostCents(undefined)).toBeNull();
  });
});

describe("Properties list rent", () => {
  it("carries the occupied rent roll through the summary projection", async () => {
    const { buildOwnerPropertySummary } = await import("@/lib/property-owner/summary");
    const row = buildOwnerPropertySummary("2026-10", {
      propertyId: "p1",
      label: "Alder Row",
      profitability: [],
      rentDueByMonth: {},
      units: 3,
      occupied: 2,
      rentRollCents: 215000,
    });
    expect(row.rentRollCents).toBe(215000);
    const bare = buildOwnerPropertySummary("2026-10", { propertyId: "p1", label: "A", profitability: [], rentDueByMonth: {}, units: 1, occupied: 0 });
    expect("rentRollCents" in bare).toBe(false);
  });
});
