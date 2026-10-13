import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs modules; the parser, guard and planners are the units under test
import { assertProjectAllowed, parseArgs } from "../../scripts/backfill-thread-workspaces.mjs";
import {
  existingConversationSlots,
  planProjectionWorkspaceBackfill,
  planThreadWorkspaceBackfill,
  referencedHouseIds,
  workIdentityReport,
  // @ts-expect-error - plain .mjs module
} from "../../scripts/lib/thread-workspace-backfill.mjs";

const SCOPE = "axis_portal_inbox_manager_v1";
const DEV = "emstjswhotsnyksqhqyf";
const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id, scope: SCOPE, owner_user_id: "o1", conversation_key: null, workspace_id: null, test_workspace_id: null, row_data: {}, ...over,
});
const base = {
  houseWorkspaceById: new Map([["h-a", "ws-a"], ["h-b", "ws-b"]]),
  workspaceByLine: new Map([["2065550002", "ws-b"], ["assist-b@proplane.ai", "ws-b"]]),
  defaultWorkspaceByOwner: new Map([["o1", "ws-a"]]),
};

describe("backfill-thread-workspaces args and project guard", () => {
  it("needs --project-ref, and --apply needs --backup-dir", () => {
    expect(() => parseArgs([])).toThrow(/--project-ref/);
    expect(() => parseArgs(["--project-ref", DEV, "--apply"])).toThrow(/--backup-dir/);
    expect(parseArgs(["--project-ref", DEV])).toMatchObject({ apply: false, projectRef: DEV });
  });

  it("refuses a project that is not the one named and a non-dev apply without --allow-project", () => {
    const url = `https://${DEV}.supabase.co`;
    expect(() => assertProjectAllowed({ url, projectRef: "otherref", apply: false })).toThrow(/does not match/);
    const prod = "https://qahnczmilgptcedaqype.supabase.co";
    expect(() => assertProjectAllowed({ url: prod, projectRef: "qahnczmilgptcedaqype", apply: true })).toThrow(/--allow-project/);
    expect(assertProjectAllowed({ url: prod, projectRef: "qahnczmilgptcedaqype", apply: true, allowProject: "qahnczmilgptcedaqype" })).toBe("qahnczmilgptcedaqype");
    expect(assertProjectAllowed({ url, projectRef: DEV, apply: true })).toBe(DEV);
  });
});

describe("planThreadWorkspaceBackfill", () => {
  it("stamps the house's workspace, else the work line's, else the owner's default", () => {
    const plan = planThreadWorkspaceBackfill({
      ...base,
      threads: [
        thread("t-house", { row_data: { rootHouseId: "h-b" } }),
        thread("t-turn", { row_data: { messages: [{ houseId: "h-b" }] } }),
        thread("t-line", { row_data: { workLine: "+1 (206) 555-0002" } }),
        thread("t-mail", { row_data: { workLine: "Assist-B@proplane.ai" } }),
        thread("t-none", { row_data: {} }),
      ],
    });
    expect(Object.fromEntries(plan.stamps.map((s: { id: string; workspaceId: string }) => [s.id, s.workspaceId]))).toEqual({
      "t-house": "ws-b", "t-turn": "ws-b", "t-line": "ws-b", "t-mail": "ws-b", "t-none": "ws-a",
    });
    expect(plan.byVia).toEqual({ house: 2, line: 2, default: 1 });
  });

  it("a house wins over a work line", () => {
    const plan = planThreadWorkspaceBackfill({ ...base, threads: [thread("t", { row_data: { rootHouseId: "h-a", workLine: "2065550002" } })] });
    expect(plan.stamps[0]).toMatchObject({ workspaceId: "ws-a", via: "house" });
  });

  it("never touches a stamped, test-workspace, resident or vendor row", () => {
    const plan = planThreadWorkspaceBackfill({
      ...base,
      threads: [
        thread("stamped", { workspace_id: "ws-a" }),
        thread("test", { test_workspace_id: "tw-1" }),
        thread("resident", { scope: "axis_portal_inbox_resident_v1" }),
        thread("vendor", { scope: "axis_portal_inbox_vendor_v1" }),
      ],
    });
    expect(plan.stamps).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.ignored).toBe(4);
  });

  it("skips and reports a thread whose houses span workspaces, an owner with no default, and no owner", () => {
    const plan = planThreadWorkspaceBackfill({
      ...base,
      threads: [
        thread("split", { row_data: { messages: [{ houseId: "h-a" }, { houseId: "h-b" }] } }),
        thread("no-default", { owner_user_id: "o2" }),
        thread("orphan", { owner_user_id: null }),
      ],
    });
    expect(plan.stamps).toEqual([]);
    expect(plan.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason])).toEqual([
      ["split", "ambiguous_houses"], ["no-default", "no_workspace"], ["orphan", "no_owner"],
    ]);
  });

  it("skips a stamp that would collide with an occupied slot, or with another planned stamp", () => {
    const occupied = existingConversationSlots([
      { scope: SCOPE, owner_user_id: "o1", workspace_id: "ws-a", conversation_key: "tel:+14255550100" },
      { scope: SCOPE, owner_user_id: "o1", workspace_id: null, conversation_key: "tel:+1ignored" },
    ]);
    const plan = planThreadWorkspaceBackfill({
      ...base,
      occupiedSlots: occupied,
      threads: [
        thread("dup-existing", { conversation_key: "tel:+14255550100" }),
        thread("first", { conversation_key: "acct:1" }),
        thread("dup-planned", { conversation_key: "acct:1" }),
        thread("other-ws", { conversation_key: "acct:1", row_data: { rootHouseId: "h-b" } }),
        thread("no-key-a"),
        thread("no-key-b"),
      ],
    });
    expect(plan.stamps.map((s: { id: string }) => s.id)).toEqual(["first", "other-ws", "no-key-a", "no-key-b"]);
    expect(plan.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason])).toEqual([
      ["dup-existing", "collision"], ["dup-planned", "collision"],
    ]);
  });

  it("lists every referenced house so the script can load their workspaces", () => {
    expect(referencedHouseIds([thread("a", { row_data: { rootHouseId: "h-a", messages: [{ houseId: "h-b" }] } }), thread("b", { row_data: { propertyId: "h-c" } })]).sort()).toEqual(["h-a", "h-b", "h-c"]);
    // A keyed thread's propertyId is a legacy field and is not a house tag.
    expect(referencedHouseIds([thread("k", { row_data: { conversationKey: "tel:+1", propertyId: "h-z" } })])).toEqual([]);
  });
});

describe("planProjectionWorkspaceBackfill", () => {
  it("uses the work line's number workspace, else the owner's default, and leaves stamped rows", () => {
    const plan = planProjectionWorkspaceBackfill({
      rows: [
        { id: "p1", owner_manager_user_id: "o1", work_line_id: "n-b", workspace_id: null },
        { id: "p2", owner_manager_user_id: "o1", work_line_id: "gone", workspace_id: null },
        { id: "p3", owner_manager_user_id: "o9", work_line_id: "gone", workspace_id: null },
        { id: "p4", owner_manager_user_id: "o1", work_line_id: "n-b", workspace_id: "ws-a" },
      ],
      numberWorkspaceById: new Map([["n-b", "ws-b"]]),
      defaultWorkspaceByOwner: base.defaultWorkspaceByOwner,
    });
    expect(plan.stamps.map((s: { id: string; workspaceId: string }) => [s.id, s.workspaceId])).toEqual([["p1", "ws-b"], ["p2", "ws-a"]]);
    expect(plan.skipped).toEqual([{ id: "p3", reason: "no_workspace" }]);
  });
});

describe("workIdentityReport", () => {
  it("counts live numbers and active emails per workspace, flags >1, reports unplaced rows", () => {
    const report = workIdentityReport({
      workspaces: [{ id: "ws-a", owner_user_id: "o1", name: "A" }, { id: "ws-b", owner_user_id: "o1", name: "B" }, { id: "ws-c", owner_user_id: "o2", name: "C" }],
      numbers: [
        { id: "n1", workspace_id: "ws-a", provision_state: "active", released_at: null },
        { id: "n2", workspace_id: "ws-a", provision_state: "pending_registration", released_at: null },
        { id: "n3", workspace_id: "ws-b", provision_state: "released", released_at: "2026-03-01" },
        { id: "n4", workspace_id: "ws-b", provision_state: "active", released_at: null },
        { id: "n5", workspace_id: null, provision_state: "active", released_at: null },
        { id: "n6", workspace_id: "ws-zzz", provision_state: "active", released_at: null },
      ],
      emails: [
        { id: "e1", workspace_id: "ws-a", provision_state: "active" },
        { id: "e2", workspace_id: "ws-a", provision_state: "released" },
        { id: "e3", workspace_id: null, provision_state: "active" },
      ],
    });
    const byId = Object.fromEntries(report.rows.map((r: { workspaceId: string }) => [r.workspaceId, r]));
    expect(byId["ws-a"]).toMatchObject({ liveNumbers: 2, activeEmails: 1 });
    expect(byId["ws-b"]).toMatchObject({ liveNumbers: 1, activeEmails: 0 });
    expect(byId["ws-c"]).toMatchObject({ liveNumbers: 0, activeEmails: 0 });
    expect(report.multiple.map((r: { workspaceId: string }) => r.workspaceId)).toEqual(["ws-a"]);
    expect(report.unplacedNumbers).toEqual(["n5"]);
    expect(report.unplacedEmails).toEqual(["e3"]);
    expect(report.unknownWorkspaceRows).toEqual([{ id: "n6", workspaceId: "ws-zzz" }]);
  });
});
