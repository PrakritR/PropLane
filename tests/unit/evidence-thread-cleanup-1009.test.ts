/**
 * Evidence harness for the duplicate-thread cleanup (2026-10-09).
 *
 * `scripts/merge-assistant-team-threads.mjs --dry-run` prints its plan through
 * `describeAssistantTeamPlan`. The script itself needs live Supabase
 * credentials, which a gate worktree does not carry, so this feeds the same
 * planner the shape of rows the cleanup exists for — an Assistant thread split
 * across a suffixed and an unsuffixed id, per-payment threads for one resident,
 * and legacy per-house Team threads — and writes the dry-run report it would
 * print (`thread-cleanup-dry-run.txt` under EVIDENCE_DIR).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  describeAssistantTeamPlan,
  planAssistantNoticeFold,
  planPaymentUpdateFold,
  planTeamThreadFold,
  type BackfillRow,
} from "@/lib/communication/assistant-team-merge";

const USER = "11111111-1111-1111-1111-111111111111";
const WS_DEFAULT = "22222222-2222-2222-2222-222222222222";
const WS_SEATTLE = "33333333-3333-3333-3333-333333333333";
const HOUSE = "44444444-4444-4444-4444-444444444444";
const SCOPE = "axis_portal_inbox_manager_v1";

const log: string[] = [];
const say = (line = "") => log.push(line);

function row(id: string, threadType: string, messages: Array<{ id: string; at: string; body: string }>, updated: string, extra: Record<string, unknown> = {}): BackfillRow {
  return {
    id, scope: SCOPE, owner_user_id: USER, participant_email: null, thread_type: threadType, updated_at: updated,
    row_data: { id, folder: "inbox", from: "PropLane Assistant", subject: "PropLane Assistant", body: "intro", time: "t", unread: false, messages, ...extra },
  } as BackfillRow;
}

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/thread-cleanup-dry-run.txt`, `${log.join("\n")}\n`);
});

describe("evidence · duplicate thread cleanup, dry run", () => {
  it("folds a split Assistant thread, a resident's per-payment threads and legacy Team threads", () => {
    say("assistant/team thread merge - project emstjswhotsnyksqhqyf - DRY RUN (nothing is written)");
    say();

    // (a) the same person's Assistant notices split across two ids.
    const assistant = planAssistantNoticeFold(
      [
        row(`agent_notice_${USER}`, "agent_notice", [
          { id: "m1", at: "2026-10-01T10:00:00.000Z", body: "Rent received" },
          { id: "m3", at: "2026-10-03T10:00:00.000Z", body: "Lease signed" },
        ], "2026-10-03T10:00:00.000Z"),
        row(`agent_notice_${USER}__${WS_DEFAULT}`, "agent_notice", [
          { id: "m2", at: "2026-10-02T10:00:00.000Z", body: "Service request opened" },
          { id: "m3", at: "2026-10-03T10:00:00.000Z", body: "Lease signed" },
        ], "2026-10-04T10:00:00.000Z", { unread: true }),
      ],
      new Map([[USER, WS_DEFAULT]]),
    );
    say("== (a) duplicate Assistant rows");
    for (const line of describeAssistantTeamPlan(assistant)) say(`   ${line}`);
    say();

    // (b) one thread per payment update for one resident.
    const ref = { workspaceId: WS_DEFAULT, key: "mail:ana@example.test", keys: ["mail:ana@example.test"], flagged: null };
    const payment = (id: string, subject: string, at: string): BackfillRow => ({
      id, scope: SCOPE, owner_user_id: USER, participant_email: null, thread_type: "portal_message", updated_at: at,
      row_data: { id, folder: "sent", from: "Manager", email: "ana@example.test", subject, body: `${subject} body`, rootAt: at, time: at, messages: [] },
    }) as BackfillRow;
    const payments = planPaymentUpdateFold([
      { row: payment("msg_a", "Rent · Payment update", "2026-10-01T10:00:00.000Z"), ref },
      { row: payment("msg_b", "Utilities · Payment update", "2026-10-02T10:00:00.000Z"), ref },
      { row: payment("msg_c", "Rent · Payment update", "2026-10-03T10:00:00.000Z"), ref },
    ] as never);
    say("== (b) per-payment threads -> the resident's one conversation");
    for (const line of describeAssistantTeamPlan(payments)) say(`   ${line}`);
    say();

    // (c) legacy Team threads, one per house, into the workspace's one Team chat.
    const team = planTeamThreadFold(
      [
        row(`team-thread:${USER}:${HOUSE}`, "team", [{ id: "t1", at: "2026-10-01T10:00:00.000Z", body: "Who has the 5257 key?" }], "2026-10-01T10:00:00.000Z"),
        row(`team-thread:${USER}`, "team", [
          { id: "t2", at: "2026-10-02T10:00:00.000Z", body: "I'll meet the plumber at 5." },
          { id: "action-event:auto-1", at: "2026-10-02T11:00:00.000Z", body: "Automated: rent received" },
        ], "2026-10-02T10:00:00.000Z"),
      ],
      {
        workspaceByHouse: new Map([[HOUSE, WS_SEATTLE]]),
        defaultWorkspaceByOwner: new Map([[USER, WS_SEATTLE]]),
        workspaceNameById: new Map([[WS_SEATTLE, "Seattle Homes"]]),
        nameByUserId: new Map([[USER, "Ambika Mago"]]),
      },
    );
    say("== (c) legacy Team threads -> one Team chat per workspace");
    for (const line of describeAssistantTeamPlan(team)) say(`   ${line}`);
    say();
    say("Dry run only: no row was changed. Re-run with --apply --backup-dir <dir> to write.");

    expect(assistant.actions).toHaveLength(1);
    expect(payments.actions).toHaveLength(1);
    expect(team.actions).toHaveLength(1);
    // Everything the cleanup keeps lands on the one canonical id per person / workspace.
    expect(describeAssistantTeamPlan(assistant)[0]).toContain(`-> agent_notice_${USER}`);
    expect(describeAssistantTeamPlan(team)[0]).toContain(`-> team-thread:${USER}:ws:${WS_SEATTLE}`);
  });
});
