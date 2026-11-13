import { describe, expect, it } from "vitest";
import { planProspectRepair, type RepairRow } from "@/lib/prospect-spine/repair-plan";

const WS = [{ id: "ws1", owner_user_id: "own", is_service: true }];
const row = (id: string, over: Partial<RepairRow> & { rd?: Record<string, unknown> } = {}): RepairRow => ({
  id, owner_user_id: "own", workspace_id: null, conversation_key: null, updated_at: "2026-11-11T10:00:00Z",
  row_data: { smsNoticePhone: "+12065550188", rootMessageId: `${id}-root`, body: "hi", rootAt: "t", ...(over.rd ?? {}) }, ...over,
});

describe("planProspectRepair", () => {
  it("folds one owner's duplicate threads for one phone and keeps every turn", () => {
    const a = row("sms_notice_a", { updated_at: "2026-11-11T09:00:00Z" });
    const b = row("sms_notice_b", { updated_at: "2026-11-11T11:00:00Z" });
    const plan = planProspectRepair([a, b], WS);
    const fold = plan.actions.find((x) => x.kind === "fold");
    expect(fold).toMatchObject({ kind: "fold", keepId: "sms_notice_b", absorbIds: ["sms_notice_a"], addedTurns: 1 });
  });
  it("never folds across owners or phones", () => {
    const plan = planProspectRepair([row("sms_notice_a"), row("sms_notice_b", { owner_user_id: "seat" }), row("sms_notice_c", { rd: { smsNoticePhone: "+12065550199" } })], WS);
    expect(plan.actions.filter((x) => x.kind === "fold")).toHaveLength(0);
  });
  it("stamps a managed owner's unkeyed thread with its workspace and the phone key", () => {
    const plan = planProspectRepair([row("sms_notice_a")], WS);
    expect(plan.actions).toEqual([{ kind: "stamp", id: "sms_notice_a", ownerUserId: "own", workspaceId: "ws1", key: "tel:+12065550188" }]);
  });
  it("leaves self-serve owners and already stamped rows alone, and is idempotent", () => {
    expect(planProspectRepair([row("sms_notice_a", { owner_user_id: "other" })], WS).actions).toEqual([]);
    expect(planProspectRepair([row("sms_notice_a", { workspace_id: "ws1", conversation_key: "tel:+12065550188" })], WS).actions).toEqual([]);
    expect(planProspectRepair([row("sms_notice_a", { rd: { mergedInto: "x", folder: "trash" } })], WS).actions).toEqual([]);
  });
  it("an owner with several workspaces and no stamp is skipped, not guessed", () => {
    const plan = planProspectRepair([row("sms_notice_a")], [...WS, { id: "ws2", owner_user_id: "own", is_service: false }]);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });
});
