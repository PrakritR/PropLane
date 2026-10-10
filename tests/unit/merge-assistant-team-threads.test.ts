import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain .mjs script; its argument parser and project guard are the units under test
import { assertProjectAllowed, parseArgs } from "../../scripts/merge-assistant-team-threads.mjs";
import {
  isPaymentUpdateRow,
  planAssistantNoticeFold,
  planPaymentUpdateFold,
  planTeamThreadFold,
  touchedIds,
  type BackfillRow,
} from "@/lib/communication/assistant-team-merge";

const USER = "11111111-1111-1111-1111-111111111111";
const DEFAULT_WS = "22222222-2222-2222-2222-222222222222";
const OTHER_WS = "33333333-3333-3333-3333-333333333333";
const SCOPE = "axis_portal_inbox_manager_v1";

function assistantRow(id: string, messages: { id: string; at: string; body: string }[], updated: string, extra: Record<string, unknown> = {}): BackfillRow {
  return {
    id,
    scope: SCOPE,
    owner_user_id: USER,
    participant_email: null,
    thread_type: "agent_notice",
    updated_at: updated,
    row_data: { id, folder: "inbox", from: "PropLane Assistant", subject: "PropLane Assistant", body: "intro", time: "t", unread: false, messages, ...extra },
  };
}

describe("assistant fold", () => {
  const defaults = new Map([[USER, DEFAULT_WS]]);

  it("folds the default workspace's suffixed id into the unsuffixed one, unioning messages by id in time order", () => {
    const canonical = assistantRow(`agent_notice_${USER}`, [
      { id: "m1", at: "2026-10-01T10:00:00.000Z", body: "first" },
      { id: "m3", at: "2026-10-03T10:00:00.000Z", body: "third" },
    ], "2026-10-03T10:00:00.000Z");
    const dup = assistantRow(`agent_notice_${USER}__${DEFAULT_WS}`, [
      { id: "m2", at: "2026-10-02T10:00:00.000Z", body: "second" },
      { id: "m3", at: "2026-10-03T10:00:00.000Z", body: "third" },
    ], "2026-10-04T10:00:00.000Z", { unread: true });
    const plan = planAssistantNoticeFold([canonical, dup], defaults);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]!;
    if (action.kind !== "assistant-fold") throw new Error("expected a fold");
    expect(action.canonicalId).toBe(`agent_notice_${USER}`);
    expect(action.createCanonical).toBe(false);
    expect(action.absorbIds).toEqual([`agent_notice_${USER}__${DEFAULT_WS}`]);
    expect((action.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(action.rowData.unread).toBe(true);
    expect(action.rowData.id).toBe(`agent_notice_${USER}`);
  });

  it("a lone row on the default workspace's suffixed id moves to the canonical id", () => {
    const only = assistantRow(`agent_notice_${USER}__${DEFAULT_WS}`, [{ id: "m1", at: "2026-10-01T10:00:00.000Z", body: "x" }], "2026-10-01T10:00:00.000Z");
    const [action] = planAssistantNoticeFold([only], defaults).actions;
    if (action?.kind !== "assistant-fold") throw new Error("expected a fold");
    expect(action.createCanonical).toBe(true);
    expect(action.canonicalId).toBe(`agent_notice_${USER}`);
    expect(action.absorbIds).toEqual([only.id]);
  });

  it("leaves a healthy single row and a genuinely different workspace alone", () => {
    const canonical = assistantRow(`agent_notice_${USER}`, [], "2026-10-01T10:00:00.000Z");
    const other = assistantRow(`agent_notice_${USER}__${OTHER_WS}`, [], "2026-10-01T10:00:00.000Z");
    expect(planAssistantNoticeFold([canonical, other], defaults).actions).toEqual([]);
  });

  it("is idempotent: planning the folded result plans nothing", () => {
    const a = assistantRow(`agent_notice_${USER}`, [{ id: "m1", at: "2026-10-01T10:00:00.000Z", body: "a" }], "2026-10-02T10:00:00.000Z");
    const b = assistantRow(`agent_notice_${USER}__${DEFAULT_WS}`, [{ id: "m2", at: "2026-10-02T10:00:00.000Z", body: "b" }], "2026-10-02T10:00:00.000Z");
    const [action] = planAssistantNoticeFold([a, b], defaults).actions;
    if (action?.kind !== "assistant-fold") throw new Error("expected a fold");
    const after = { ...a, row_data: action.rowData };
    expect(planAssistantNoticeFold([after], defaults).actions).toEqual([]);
  });

  it("touchedIds names every row a fold reads or writes", () => {
    const a = assistantRow(`agent_notice_${USER}`, [], "2026-10-01T10:00:00.000Z");
    const b = assistantRow(`agent_notice_${USER}__${DEFAULT_WS}`, [], "2026-10-02T10:00:00.000Z");
    const [action] = planAssistantNoticeFold([a, b], defaults).actions;
    expect(new Set(touchedIds(action!))).toEqual(new Set([a.id, b.id]));
  });
});

describe("payment-update fold", () => {
  function paymentRow(id: string, subject: string, at: string, updated: string, extra: Partial<BackfillRow> = {}): BackfillRow {
    return {
      id,
      scope: SCOPE,
      owner_user_id: USER,
      participant_email: null,
      thread_type: "portal_message",
      updated_at: updated,
      row_data: { id, folder: "sent", from: "Manager", email: "res@example.com", subject, body: `${subject} body`, rootAt: at, time: at, messages: [] },
      ...extra,
    };
  }
  const ref = { workspaceId: DEFAULT_WS, key: "mail:res@example.com", keys: ["mail:res@example.com"], flagged: null };

  it("recognizes only the per-payment msg_* threads", () => {
    expect(isPaymentUpdateRow(paymentRow("msg_a", "Rent · Payment update", "t", "t"))).toBe(true);
    expect(isPaymentUpdateRow(paymentRow("msg_a", "Hello", "t", "t"))).toBe(false);
    expect(isPaymentUpdateRow(paymentRow("showcase-a", "Rent · Payment update", "t", "t"))).toBe(false);
  });

  it("folds same-resident payment threads into one, keeping history in time order", () => {
    const a = paymentRow("msg_a", "Rent · Payment update", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z");
    const b = paymentRow("msg_b", "Utilities · Payment update", "2026-10-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z");
    const plan = planPaymentUpdateFold([{ row: a, ref }, { row: b, ref }]);
    const merges = plan.actions.filter((action) => action.kind === "merge");
    expect(merges).toHaveLength(1);
    const merge = merges[0]!;
    if (merge.kind !== "merge") throw new Error("expected a merge");
    expect(merge.keepId).toBe("msg_b");
    expect(merge.absorbIds).toEqual(["msg_a"]);
    expect(merge.turns).toBe(2);
    expect(merge.rowData.aliasIds).toEqual(["msg_a"]);
  });

  it("folds payment threads into the keyed conversation the resident already has, and never absorbs other threads", () => {
    const keyed = paymentRow("conv_1", "Hello", "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z", {
      conversation_key: ref.key,
      workspace_id: ref.workspaceId,
    });
    keyed.row_data = { ...keyed.row_data!, messages: [{ id: "x1", from: "Manager", body: "hi", at: "2026-09-01T10:00:00.000Z", outbound: true }] };
    const pay = paymentRow("msg_a", "Rent · Payment update", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z");
    const showcase = paymentRow("showcase-thread-x", "Seeded", "2026-10-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z");
    const plan = planPaymentUpdateFold([{ row: keyed, ref }, { row: pay, ref }, { row: showcase, ref }]);
    const merge = plan.actions.find((action) => action.kind === "merge");
    if (merge?.kind !== "merge") throw new Error("expected a merge");
    expect(merge.keepId).toBe("conv_1");
    expect(merge.absorbIds).toEqual(["msg_a"]);
    expect(plan.actions.some((action) => "id" in action && action.id === "showcase-thread-x")).toBe(false);
  });

  it("different residents stay separate", () => {
    const a = paymentRow("msg_a", "Rent · Payment update", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z");
    const b = paymentRow("msg_b", "Rent · Payment update", "2026-10-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z");
    const other = { ...ref, key: "mail:other@example.com", keys: ["mail:other@example.com"] };
    const plan = planPaymentUpdateFold([{ row: a, ref }, { row: b, ref: other }]);
    expect(plan.actions.filter((action) => action.kind === "merge")).toHaveLength(0);
  });
});

describe("team fold (--team)", () => {
  const OWNER = USER;
  const HOUSE_A = "house-a";
  const HOUSE_B = "house-b";
  const HOUSE_C = "house-c";
  const context = {
    workspaceByHouse: new Map([[HOUSE_A, DEFAULT_WS], [HOUSE_B, DEFAULT_WS], [HOUSE_C, OTHER_WS]]),
    defaultWorkspaceByOwner: new Map([[OWNER, DEFAULT_WS]]),
    workspaceNameById: new Map([[DEFAULT_WS, "Seattle Homes"], [OTHER_WS, "Portland"]]),
    nameByUserId: new Map([[OWNER, "Ambika Mago"]]),
  };
  const teamRow = (id: string, over: Record<string, unknown>, messages: Record<string, unknown>[], updated: string): BackfillRow => ({
    id,
    scope: SCOPE,
    owner_user_id: OWNER,
    participant_email: null,
    thread_type: "team",
    updated_at: updated,
    row_data: { id, folder: "inbox", from: "Ambika Mago", subject: "Team", body: "", time: "t", unread: false, messages, ...over },
  });

  it("folds per-house and house-less rows of one workspace into the workspace chat: lines unioned by id in time order, root dressed as the thread becomes its author's line", () => {
    const a = teamRow(`team-thread:${OWNER}:${HOUSE_A}`, {
      body: "I'll meet the plumber", rootMessageId: "root-a", rootAt: "2026-10-01T09:00:00.000Z", rootActorUserId: OWNER, propertyId: HOUSE_A,
    }, [{ id: "a2", from: "Prakrit", body: "ok", at: "2026-10-01T10:00:00.000Z", actorUserId: "p" }], "2026-10-01T10:00:00.000Z");
    const b = teamRow(`team-thread:${OWNER}:${HOUSE_B}`, { propertyId: HOUSE_B, aiDraft: { text: "draft" } }, [
      { id: "b1", from: "Akshaya", body: "gate code", at: "2026-10-01T09:30:00.000Z" },
      { id: "a2", from: "Prakrit", body: "ok", at: "2026-10-01T10:00:00.000Z" },
    ], "2026-10-01T09:30:00.000Z");
    const houseless = teamRow(`team-thread:${OWNER}`, {}, [{ id: "h1", from: "Ambika Mago", body: "hi", at: "2026-10-01T08:00:00.000Z" }], "2026-10-01T08:00:00.000Z");
    const plan = planTeamThreadFold([a, b, houseless], context);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]!;
    if (action.kind !== "team-fold") throw new Error("expected a team fold");
    expect(action.canonicalId).toBe(`team-thread:${OWNER}:ws:${DEFAULT_WS}`);
    expect(action.createCanonical).toBe(true);
    expect(action.workspaceId).toBe(DEFAULT_WS);
    expect([...action.absorbIds].sort()).toEqual([a.id, b.id, houseless.id].sort());
    const messages = action.rowData.messages as Array<{ id: string; from: string; channel: string }>;
    expect(messages.map((m) => m.id)).toEqual(["h1", "root-a", "b1", "a2"]);
    // The old root was named after the thread; its author is restored.
    expect(messages.find((m) => m.id === "root-a")).toMatchObject({ from: "Ambika Mago", actorUserId: OWNER, channel: "proplane" });
    expect(action.rowData).toMatchObject({
      id: action.canonicalId, from: "Team · Seattle Homes", subject: "Team · Seattle Homes", workspaceId: DEFAULT_WS,
    });
    // House tags and review drafts of the per-house threads do not describe a workspace chat.
    expect(action.rowData).not.toHaveProperty("propertyId");
    expect(action.rowData).not.toHaveProperty("aiDraft");
    expect(action.turns).toBe(4);
    expect([...new Set(touchedIds(action))].sort()).toEqual([...new Set([action.baseId, action.canonicalId, ...action.absorbIds])].sort());
  });

  it("a house goes to ITS workspace, a house-less thread to the owner's default, and two workspaces never merge", () => {
    const a = teamRow(`team-thread:${OWNER}:${HOUSE_A}`, {}, [{ id: "a1", from: "x", body: "one", at: "2026-10-01T09:00:00.000Z" }], "2026-10-01T09:00:00.000Z");
    const c = teamRow(`team-thread:${OWNER}:${HOUSE_C}`, {}, [{ id: "c1", from: "x", body: "two", at: "2026-10-01T09:00:00.000Z" }], "2026-10-01T09:00:00.000Z");
    const plan = planTeamThreadFold([a, c], context);
    expect(plan.actions.map((x) => (x.kind === "team-fold" ? x.canonicalId : "")).sort()).toEqual(
      [`team-thread:${OWNER}:ws:${DEFAULT_WS}`, `team-thread:${OWNER}:ws:${OTHER_WS}`].sort(),
    );
  });

  it("automated notice lines are not carried into the human chat; notice-only rows are retired, not turned into an empty chat", () => {
    const noticeOnly = teamRow(`team-thread:${OWNER}:${HOUSE_A}`, {}, [
      { id: `action-event:k1:team:${OWNER}`, from: "PropLane Portal", body: "$1,000 received", at: "2026-10-01T09:00:00.000Z" },
    ], "2026-10-01T09:00:00.000Z");
    const [action] = planTeamThreadFold([noticeOnly], context).actions;
    if (action?.kind !== "team-fold") throw new Error("expected a team fold");
    expect(action.droppedNotices).toBe(1);
    expect(action.turns).toBe(0);
    expect(action.retire).toBe(true);
    expect(action.absorbIds).toEqual([noticeOnly.id]);
  });

  it("mixed rows keep the human lines and drop the notices (never retire a chat that has people in it)", () => {
    const mixed = teamRow(`team-thread:${OWNER}:${HOUSE_A}`, {}, [
      { id: `action-event:k1:team:${OWNER}`, from: "PropLane Portal", body: "$1,000 received", at: "2026-10-01T09:00:00.000Z" },
      { id: "team-reply:1", from: "Prakrit", body: "on it", at: "2026-10-01T10:00:00.000Z" },
    ], "2026-10-01T10:00:00.000Z");
    const [action] = planTeamThreadFold([mixed], context).actions;
    if (action?.kind !== "team-fold") throw new Error("expected a team fold");
    expect(action.retire).toBe(false);
    expect((action.rowData.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["team-reply:1"]);
  });

  it("an existing workspace chat is the base: a lone healthy row is left alone, legacy rows fold into it", () => {
    const canonicalId = `team-thread:${OWNER}:ws:${DEFAULT_WS}`;
    const healthy = teamRow(canonicalId, { rootMessageId: `team-root:${canonicalId}`, workspaceId: DEFAULT_WS }, [{ id: "w1", from: "x", body: "one", at: "2026-10-01T09:00:00.000Z" }], "2026-10-01T09:00:00.000Z");
    expect(planTeamThreadFold([healthy], context).actions).toEqual([]);
    const legacy = teamRow(`team-thread:${OWNER}:${HOUSE_A}`, {}, [{ id: "a1", from: "x", body: "two", at: "2026-10-02T09:00:00.000Z" }], "2026-10-02T09:00:00.000Z");
    const [action] = planTeamThreadFold([healthy, legacy], context).actions;
    if (action?.kind !== "team-fold") throw new Error("expected a team fold");
    expect(action.createCanonical).toBe(false);
    expect(action.baseId).toBe(canonicalId);
    expect(action.absorbIds).toEqual([legacy.id]);
    expect((action.rowData.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["w1", "a1"]);
  });

  it("an owner with no workspace for the house or a default is skipped with a reason, never guessed", () => {
    const orphan = teamRow(`team-thread:nobody:${HOUSE_A}`, {}, [], "2026-10-01T09:00:00.000Z");
    orphan.owner_user_id = "nobody";
    const plan = planTeamThreadFold([orphan], { ...context, workspaceByHouse: new Map() });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.id).toBe(orphan.id);
  });

  it("plans nothing for no rows (the script's default without --team)", () => {
    expect(planTeamThreadFold([])).toEqual({ actions: [], skipped: [] });
  });
});

describe("script arguments and guard", () => {
  it("requires --project-ref and is a dry run by default", () => {
    expect(() => parseArgs([])).toThrow(/project-ref/);
    expect(parseArgs(["--project-ref", "abc"])).toMatchObject({ apply: false, projectRef: "abc", team: false });
  });

  it("--apply needs a backup directory", () => {
    expect(() => parseArgs(["--project-ref", "abc", "--apply"])).toThrow(/backup-dir/);
    expect(parseArgs(["--project-ref", "abc", "--apply", "--backup-dir", "/tmp/b"])).toMatchObject({ apply: true, backupDir: "/tmp/b" });
  });

  it("refuses unknown flags", () => {
    expect(() => parseArgs(["--project-ref", "abc", "--force"])).toThrow(/Unknown option/);
  });

  it("refuses unless the environment's project is the named one", () => {
    const url = "https://emstjswhotsnyksqhqyf.supabase.co";
    expect(assertProjectAllowed({ url, projectRef: "emstjswhotsnyksqhqyf", apply: false })).toBe("emstjswhotsnyksqhqyf");
    expect(() => assertProjectAllowed({ url, projectRef: "someotherproject", apply: false })).toThrow(/does not match/);
    expect(() => assertProjectAllowed({ url: "http://localhost:54321", projectRef: "x", apply: false })).toThrow(/not a Supabase/);
  });

  it("--apply refuses any project but dev/test unless it is explicitly allowed", () => {
    const url = "https://qahnczmilgptcedaqype.supabase.co";
    expect(() => assertProjectAllowed({ url, projectRef: "qahnczmilgptcedaqype", apply: true })).toThrow(/allow-project/);
    expect(assertProjectAllowed({ url, projectRef: "qahnczmilgptcedaqype", apply: true, allowProject: "qahnczmilgptcedaqype" })).toBe(
      "qahnczmilgptcedaqype",
    );
    expect(assertProjectAllowed({ url: "https://emstjswhotsnyksqhqyf.supabase.co", projectRef: "emstjswhotsnyksqhqyf", apply: true })).toBe(
      "emstjswhotsnyksqhqyf",
    );
  });
});
