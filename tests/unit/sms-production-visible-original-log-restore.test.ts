import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_PREDICATE_LOCK_TABLES,
  assertRestoreProjectionPristine,
  lockRestorePredicates,
} from "../../scripts/sms-production-visible-original-log-restore.mjs";

describe("visible-original restoration predicate locks", () => {
  it("locks each writer-facing predicate table in one stable order", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await lockRestorePredicates({ query });
    expect(RESTORE_PREDICATE_LOCK_TABLES).toEqual([
      "manager_sms_messages",
      "manager_sms_numbers",
      "portal_inbox_thread_records",
      "portal_workspaces",
      "sms_relay_messages",
      "sms_projection_aliases",
      "sms_projection_ambiguous_aliases",
      "sms_projection_conversations",
      "sms_projection_cutover",
      "sms_projection_deleted_events",
      "sms_projection_pending",
      "sms_projection_turns",
      "sms_projection_view_state",
    ]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(
      RESTORE_PREDICATE_LOCK_TABLES.map((table) => `lock table public.${table} in share mode`),
    );
  });

  it("requires an empty projection and a disabled cutover after schema installation", async () => {
    const empty = Object.fromEntries(RESTORE_PREDICATE_LOCK_TABLES
      .filter((table) => table.startsWith("sms_projection_") && table !== "sms_projection_cutover")
      .map((table) => [table, "0"]));
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{ cutover_ready: false, ...empty }] }));
    await expect(assertRestoreProjectionPristine({ query })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ cutover_ready: false, ...empty, sms_projection_turns: "1" }] });
    await expect(assertRestoreProjectionPristine({ query })).rejects.toThrow("not empty");
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ cutover_ready: true, ...empty }] });
    await expect(assertRestoreProjectionPristine({ query })).rejects.toThrow("not empty");
  });

  it("stops before any later lock if one predicate lock times out", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("manager_sms_numbers")) throw new Error("lock timeout");
      return { rows: [] };
    });
    await expect(lockRestorePredicates({ query })).rejects.toThrow("lock timeout");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
