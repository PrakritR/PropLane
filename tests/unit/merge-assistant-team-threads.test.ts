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

describe("team hook (stage 2)", () => {
  it("plans nothing today", () => {
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
