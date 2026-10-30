import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import catalog from "../e2e/support/draft-fk-catalog.json";
import { cleanupSplitBDraft, preflightSplitBDraft, type SplitBDraftManifest } from "../helpers/split-b-draft-proof";
const input = { managerId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", propertyId: "mgr-split-b-44444444-4444-4444-8444--abc123def456", marker: "split-b-44444444-4444-4444-8444-444444444444", updatedAt: "2026-10-30T00:00:00Z" };
function fixture(opts: { connection?: boolean; descendant?: boolean; wrongOwner?: boolean } = {}) {
  return { async query(sql: string) {
    if (sql.includes("select owner_user_id")) return { rows: [{ owner_user_id: opts.wrongOwner ? input.workspaceId : input.managerId, is_service: false }] };
    if (sql.includes("listing_channel_connections")) return { rows: [{ count: opts.connection ? 1 : 0 }] };
    if (sql.includes("select status,manager_user_id")) return { rows: [{ status: "draft", manager_user_id: input.managerId, workspace_id: input.workspaceId, updated_at: input.updatedAt, row_data: { name: input.marker } }] };
    if (sql.includes("pg_constraint")) return { rows: catalog.rows.filter((r) => r.parent_table === "manager_property_records") };
    if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "listing_channel_posts" }] };
    return { rows: [{ count: opts.descendant ? 1 : 0 }] };
  } };
}
describe("split B private draft safety", () => {
  it("accepts exact owned draft with no dependencies", async () => { await expect(preflightSplitBDraft(fixture(), input, "draft")).resolves.toBeUndefined(); });
  it("denies a connected workspace, a descendant, or owner drift", async () => { for (const options of [{ connection: true }, { descendant: true }, { wrongOwner: true }]) await expect(preflightSplitBDraft(fixture(options), input, "draft")).rejects.toThrow(); });
  it("retains manifest when the captured revision loses the delete race", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "split-b-"));
    try {
      const manifest: SplitBDraftManifest = { ...input, state: "saved" };
      const filters: Array<[string, unknown]> = [];
      let deleting = false;
      const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, limit: () => query, delete: () => { deleting = true; return query; }, then: (resolve: (v: unknown) => unknown) => resolve({ data: deleting ? [] : [{ id: input.propertyId }], error: null }) };
      const db = { from: () => query };
      await expect(cleanupSplitBDraft(db as never, manifest, path.join(dir, "manifest.json"), { serverStopped: true, preflight: vi.fn(async () => {}) })).rejects.toThrow(/uncertain/);
      expect(filters).toContainEqual(["updated_at", input.updatedAt]);
      expect(manifest.state).toBe("delete_started");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses cleanup while the proof server runs", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "split-b-"));
    try {
      const manifest: SplitBDraftManifest = { ...input, state: "saved" };
      const preflight = vi.fn();
      await expect(cleanupSplitBDraft({} as never, manifest, path.join(dir, "manifest.json"), { serverStopped: false, preflight })).rejects.toThrow(/Stopped server/);
      expect(preflight).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
