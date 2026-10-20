/**
 * Workspace comms isolation (Oct 12 2026), sections 3-4 of the approved plan:
 * one work number per workspace, no cross-workspace send fallback, a transfer
 * that moves the work identity, and a unique index that ignores released rows.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";
import { resolveOwnerSendNumberRow } from "@/lib/sms/manager-workspace-role.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE, WORKSPACE_NO_WORK_NUMBER_MESSAGE } from "@/lib/sms/workspace-no-work-number";
import { ensureManagerNumberRecord, getWorkspaceNumberRecord } from "@/lib/sms/manager-number-provisioning.server";

const owner = "owner-1";
const WS_A = "ws-a"; // default
const WS_B = "ws-b";
const cols = "manager_user_id, workspace_id, phone_number, provision_state, released_at";

const workspaces = [
  { id: WS_A, owner_user_id: owner, name: "A", is_default: true, created_at: "2026-01-01" },
  { id: WS_B, owner_user_id: owner, name: "B", is_default: false, created_at: "2026-02-01" },
];
const houses = [
  { id: "house-a", manager_user_id: owner, workspace_id: WS_A, row_data: {} },
  { id: "house-b", manager_user_id: owner, workspace_id: WS_B, row_data: {} },
  { id: "house-unplaced", manager_user_id: owner, workspace_id: null, row_data: {} },
];
const numberA = { id: "n-a", manager_user_id: owner, workspace_id: WS_A, phone_number: "+12065550001", provision_state: "active", released_at: null };
const numberB = { id: "n-b", manager_user_id: owner, workspace_id: WS_B, phone_number: "+12065550002", provision_state: "active", released_at: null };

const seed = (extra: Record<string, Record<string, unknown>[]> = {}) =>
  createWorkspaceMemoryDb({ portal_workspaces: workspaces, manager_property_records: houses, ...extra });

describe("resolveOwnerSendNumberRow: a workspace sends only from its own number", () => {
  it("a house in workspace B sends from B's number, a house in A from A's", async () => {
    const db = seed({ manager_sms_numbers: [numberA, numberB] });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-b" })).data?.phone_number).toBe("+12065550002");
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-a" })).data?.phone_number).toBe("+12065550001");
  });

  it("a house in B with no number of its own does NOT fall back to the owner's only line in A", async () => {
    const db = seed({ manager_sms_numbers: [numberA] });
    const result = await resolveOwnerSendNumberRow(db as never, owner, cols, { propertyId: "house-b" });
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: "This workspace has no work number.", code: WORKSPACE_NO_WORK_NUMBER_CODE });
    expect(WORKSPACE_NO_WORK_NUMBER_MESSAGE).toBe("This workspace has no work number.");
  });

  it("a house in one of PropLane's own service workspaces (is_service) sends from the owner's default line; a customer workspace never does", async () => {
    const service = [workspaces[0], { ...workspaces[1], is_service: true }];
    const db = createWorkspaceMemoryDb({ portal_workspaces: service, manager_property_records: houses, manager_sms_numbers: [numberA] });
    const viaService = await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-b" });
    expect(viaService.data?.phone_number).toBe("+12065550001");
    const customer = seed({ manager_sms_numbers: [numberA] });
    expect((await resolveOwnerSendNumberRow(customer as never, owner, cols, { propertyId: "house-b" })).error?.code).toBe(WORKSPACE_NO_WORK_NUMBER_CODE);
  });

  it("a house-less send goes to the DEFAULT workspace's number, never another workspace's", async () => {
    const db = seed({ manager_sms_numbers: [numberB] });
    const result = await resolveOwnerSendNumberRow(db as never, owner, cols, {});
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe(WORKSPACE_NO_WORK_NUMBER_CODE);
    const withDefault = seed({ manager_sms_numbers: [numberA, numberB] });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(withDefault as never, owner, cols, {})).data?.phone_number).toBe("+12065550001");
  });

  it("an unplaced house belongs to the default workspace", async () => {
    const db = seed({ manager_sms_numbers: [numberA, numberB] });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-unplaced" })).data?.phone_number).toBe("+12065550001");
  });

  it("an unplaced legacy row (workspace_id null) answers for the default workspace only", async () => {
    const legacy = { id: "n-legacy", manager_user_id: owner, workspace_id: null, phone_number: "+12065559999", provision_state: "active", released_at: null };
    const db = seed({ manager_sms_numbers: [legacy] });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, {})).data?.phone_number).toBe("+12065559999");
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-a" })).data?.phone_number).toBe("+12065559999");
    const other = await resolveOwnerSendNumberRow(db as never, owner, cols, { propertyId: "house-b" });
    expect(other.data).toBeNull();
    expect(other.error?.code).toBe(WORKSPACE_NO_WORK_NUMBER_CODE);
  });

  it("a released row does not shadow the workspace's live one", async () => {
    const released = { ...numberB, id: "n-b-old", phone_number: "+12065550003", provision_state: "released", released_at: "2026-03-01" };
    const db = seed({ manager_sms_numbers: [released, numberB] });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-b" })).data?.phone_number).toBe("+12065550002");
  });

  it("a number the workspace holds via sharing is still its own line", async () => {
    const db = seed({
      manager_sms_numbers: [numberA],
      workspace_work_numbers: [
        { workspace_id: WS_A, number_id: "n-a", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: WS_B, number_id: "n-a", is_primary: false, created_at: "2026-02-03" },
      ],
    });
    expect((await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, { propertyId: "house-b" })).data?.phone_number).toBe("+12065550001");
  });
});

describe("number records are per workspace and survive a released row beside the live one", () => {
  it("getWorkspaceNumberRecord returns the live row, not the released one", async () => {
    const released = { ...numberB, id: "n-b-old", phone_number: "+12065550003", provision_state: "released", released_at: "2026-03-01" };
    const db = seed({ manager_sms_numbers: [released, numberB] });
    await expect(getWorkspaceNumberRecord(db as never, WS_B)).resolves.toMatchObject({ phoneNumber: "+12065550002" });
  });

  it("ensureManagerNumberRecord inserts a pending row (no ON CONFLICT on the partial index) and is idempotent", async () => {
    const db = seed({ manager_sms_numbers: [] });
    const first = await ensureManagerNumberRecord(db as never, owner, WS_B);
    expect(first).toMatchObject({ workspaceId: WS_B, provisionState: "pending_registration" });
    await ensureManagerNumberRecord(db as never, owner, WS_B);
    expect(db.__tables.manager_sms_numbers.filter((r: Record<string, unknown>) => r.workspace_id === WS_B)).toHaveLength(1);
  });

  it("no source file upserts manager_sms_numbers on workspace_id any more", () => {
    const source = readFileSync(resolve("src/lib/sms/manager-number-provisioning.server.ts"), "utf8");
    expect(source).not.toMatch(/\.upsert\(/);
    const seedScript = readFileSync(resolve("scripts/app-store-seed.mjs"), "utf8");
    expect(seedScript).not.toMatch(/manager_sms_numbers"\)\.upsert/);
  });
});

describe("migration 20261012121000: transfer moves the work identity, index ignores released rows", () => {
  const sql = readFileSync(resolve("supabase/migrations/20261012121000_workspace_transfer_moves_work_identity.sql"), "utf8");
  const original = readFileSync(resolve("supabase/migrations/20260921000000_workspace_ownership_transfer.sql"), "utf8");

  it("re-creates the transfer function with the same signature and grants, plus the two new updates", () => {
    expect(sql).toContain("create or replace function public.transfer_portal_workspace_ownership(");
    expect(sql).toMatch(/update public\.manager_sms_numbers\s+set manager_user_id = p_to[\s\S]*?where workspace_id = p_workspace and manager_user_id = p_from/);
    expect(sql).toMatch(/update public\.manager_assistant_emails\s+set manager_user_id = p_to[\s\S]*?where workspace_id = p_workspace and manager_user_id = p_from/);
    expect(sql).toContain("revoke all on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.transfer_portal_workspace_ownership(uuid, uuid, uuid, text, jsonb) to service_role;");
  });

  it("keeps every property table list identical to the original function", () => {
    const lists = (text: string) => [...text.matchAll(/(v_property_tables|v_assigned_property_id_tables) text\[\] := array\[([\s\S]*?)\];/g)].map((m) => `${m[1]}:${m[2].replace(/\s+/g, "")}`);
    expect(lists(sql)).toEqual(lists(original));
  });

  it("clears the old owner's profile cache only when it names a number that left", () => {
    expect(sql).toMatch(/update public\.profiles\s+set sms_from_number = null[\s\S]*?id = p_from and sms_from_number = any\(v_moved_numbers\)/);
  });

  it("swaps the full unique index for one over live rows only", () => {
    expect(sql).toContain("drop index if exists public.manager_sms_numbers_workspace_uniq;");
    expect(sql).toMatch(/create unique index if not exists manager_sms_numbers_workspace_uniq\s+on public\.manager_sms_numbers \(workspace_id\) where released_at is null;/);
  });

  it("is additive: no table or column drops", () => {
    expect(sql).not.toMatch(/drop (table|column)/i);
  });
});

/**
 * Reviewer-visible evidence: the send-number decision, as the manager experiences it. Writes a
 * transcript to `$EVIDENCE_DIR` (default: the OS temp dir) showing, per house, which work number a
 * text goes out from — and the exact words a manager sees when the workspace has none.
 */
describe("evidence: what a manager is told when a workspace has no work number", () => {
  it("writes the send-number decision table", async () => {
    const lines: string[] = [];
    const ask = async (label: string, db: unknown, target: { propertyId?: string }) => {
      const result = await resolveOwnerSendNumberRow<{ phone_number: string }>(db as never, owner, cols, target);
      lines.push(
        `  ${label.padEnd(46)} ${result.data ? `sends from ${result.data.phone_number}` : `refused: "${result.error?.message}"`}`,
      );
      return result;
    };

    lines.push("Both workspaces have a number of their own:");
    const both = seed({ manager_sms_numbers: [numberA, numberB] });
    expect((await ask("house in workspace A (default)", both, { propertyId: "house-a" })).data?.phone_number).toBe("+12065550001");
    expect((await ask("house in workspace B", both, { propertyId: "house-b" })).data?.phone_number).toBe("+12065550002");
    expect((await ask("no house named (the default workspace)", both, {})).data?.phone_number).toBe("+12065550001");

    lines.push("", "Only workspace A has a number — B must not borrow it:");
    const onlyA = seed({ manager_sms_numbers: [numberA] });
    expect((await ask("house in workspace A (default)", onlyA, { propertyId: "house-a" })).data?.phone_number).toBe("+12065550001");
    const refused = await ask("house in workspace B", onlyA, { propertyId: "house-b" });
    expect(refused.data).toBeNull();
    expect(refused.error).toEqual({ message: WORKSPACE_NO_WORK_NUMBER_MESSAGE, code: WORKSPACE_NO_WORK_NUMBER_CODE });

    lines.push("", "Only workspace B has a number — a house-less send does not fall back to it:");
    const onlyB = seed({ manager_sms_numbers: [numberB] });
    expect((await ask("no house named (the default workspace)", onlyB, {})).error?.code).toBe(WORKSPACE_NO_WORK_NUMBER_CODE);
    expect((await ask("house in workspace B", onlyB, { propertyId: "house-b" })).data?.phone_number).toBe("+12065550002");

    const out = process.env.EVIDENCE_DIR ?? tmpdir();
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "workspace-send-number.txt"),
      [
        "One work number per workspace, no cross-workspace fallback.",
        "Fixture: owner-1 holds workspace A (default, +1 206 555 0001) and workspace B (+1 206 555 0002).",
        "",
        ...lines,
        "",
      ].join("\n"),
    );
  });
});
