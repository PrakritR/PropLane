import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_PREDICATE_LOCK_TABLES,
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
    ]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(
      RESTORE_PREDICATE_LOCK_TABLES.map((table) => `lock table public.${table} in share mode`),
    );
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
