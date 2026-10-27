import { describe, expect, it } from "vitest";
import { isArchivedWorkspaceRow, isMissingArchivedColumn, withoutArchivedWorkspaces } from "@/lib/workspaces/archived";

describe("archived workspaces (emptied by Combine all into one)", () => {
  it("a row with archived_at set is archived; a row without the field, or with null, is not", () => {
    expect(isArchivedWorkspaceRow({ id: "a", archived_at: "2026-10-27T00:00:00.000Z" })).toBe(true);
    expect(isArchivedWorkspaceRow({ id: "a", archived_at: null })).toBe(false);
    expect(isArchivedWorkspaceRow({ id: "a" })).toBe(false);
    expect(isArchivedWorkspaceRow(null)).toBe(false);
  });

  it("lists leave archived workspaces out and tolerate a missing list", () => {
    const rows = [{ id: "a", archived_at: null }, { id: "b", archived_at: "2026-10-27" }, { id: "c" }];
    expect(withoutArchivedWorkspaces(rows).map((r) => r.id)).toEqual(["a", "c"]);
    expect(withoutArchivedWorkspaces(null)).toEqual([]);
  });

  it("a database one migration behind (no column) is told by SQLSTATE or PostgREST code, never by message", () => {
    expect(isMissingArchivedColumn({ code: "42703" })).toBe(true);
    expect(isMissingArchivedColumn({ code: "PGRST204" })).toBe(true);
    expect(isMissingArchivedColumn({ code: "XX000" })).toBe(false);
    expect(isMissingArchivedColumn({ code: undefined })).toBe(false);
    expect(isMissingArchivedColumn(null)).toBe(false);
  });
});
