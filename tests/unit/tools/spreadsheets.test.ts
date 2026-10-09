import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";

const fetchBindingTable = vi.hoisted(() => vi.fn());
const syncManagerLinkedSheet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sheet-sync/fetch-sheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sheet-sync/fetch-sheet")>()),
  fetchBindingTable,
}));
vi.mock("@/lib/sheet-sync/apply.server", () => ({ syncManagerLinkedSheet }));
vi.mock("@/lib/sheet-sync/google-sheets-auth", () => ({ getGoogleSheetsAccessToken: vi.fn(async () => null) }));

import { listSpreadsheetsTool, readSpreadsheetTool, syncSpreadsheetTool } from "@/lib/tools/domains/spreadsheets";
import { API_KEY_PRODUCT_AREAS } from "@/lib/mcp/capabilities";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

type Row = Record<string, unknown>;

function makeCtx(settings: Row[], overrides: Partial<AgentContext> = {}): AgentContext {
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => (filters.push([col, val]), q),
        maybeSingle: async () => {
          const rows = table === "manager_automation_settings" ? settings : [];
          return { data: rows.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null, error: null };
        },
        insert: async () => ({ error: null }),
      };
      return q;
    },
  };
  return {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
    ...overrides,
  } as unknown as AgentContext;
}

const rawLink = {
  id: "sheet_raw",
  title: "Rent roll",
  spreadsheetId: "csv_1",
  source: "csv",
  csvUrl: "https://example.com/a.csv",
  mode: "raw",
  refreshMinutes: 60,
  workspaceId: "w1",
  lastSyncedAt: "2026-10-08T10:00:00.000Z",
  lastSummary: "Cached 3 rows x 2 columns",
  rawHeaders: ["name", "rent"],
  rawRows: [["a", "1"], ["b", "2"], ["c", "3"]],
  rawFetchedAt: "2026-10-08T10:00:00.000Z",
};
const otherLink = { id: "sheet_g", title: "Other", spreadsheetId: "gid123", workspaceId: "w2" };

const settings = (links: Row[], owner = "manager_a"): Row[] => [
  { manager_user_id: owner, row_data: { sheetLinks: links } },
];

beforeEach(() => {
  fetchBindingTable.mockReset();
  syncManagerLinkedSheet.mockReset();
});

describe("spreadsheet tools", () => {
  it("are registered under operations as read / write", () => {
    const ops = API_KEY_PRODUCT_AREAS.find((a) => a.id === "operations")!;
    expect(ops.readTools).toEqual(expect.arrayContaining(["list_spreadsheets", "read_spreadsheet"]));
    expect(ops.writeTools).toContain("sync_spreadsheet");
    expect(listSpreadsheetsTool.kind).toBe("read");
    expect(readSpreadsheetTool.kind).toBe("read");
    expect(syncSpreadsheetTool.kind).toBe("write");
  });

  it("list_spreadsheets returns only this manager's sheets, without raw rows", async () => {
    const ctx = makeCtx([...settings([rawLink, otherLink]), ...settings([{ ...rawLink, id: "theirs" }], "manager_b")]);
    const out = (await listSpreadsheetsTool.handler(ctx, {})) as Row[];
    expect(out.map((r) => r.id)).toEqual(["sheet_raw", "sheet_g"]);
    expect(out[0]).toMatchObject({ source: "csv", mode: "raw", refreshMinutes: 60, lastError: null });
    expect(JSON.stringify(out)).not.toContain("rawRows");
  });

  it("list_spreadsheets honours the active workspace", async () => {
    const ctx = makeCtx(settings([rawLink, otherLink]), {
      workspace: { id: "w1", name: "A", isDefault: true, narrowing: true, propertyIds: [] },
    });
    const out = (await listSpreadsheetsTool.handler(ctx, {})) as Row[];
    expect(out.map((r) => r.id)).toEqual(["sheet_raw"]);
  });

  it("read_spreadsheet serves the raw cache with paging", async () => {
    const ctx = makeCtx(settings([rawLink]));
    const out = await readSpreadsheetTool.handler(ctx, { id: "sheet_raw", limit: 2, offset: 1 });
    expect(out).toMatchObject({ headers: ["name", "rent"], rows: [["b", "2"], ["c", "3"]], total: 3, truncated: false });
    expect(fetchBindingTable).not.toHaveBeenCalled();
  });

  it("read_spreadsheet fetches live when fresh, and reports a page truncation", async () => {
    fetchBindingTable.mockResolvedValue({ rows: [["h"], ["1"], ["2"], ["3"]], error: null });
    const ctx = makeCtx(settings([rawLink]));
    const out = await readSpreadsheetTool.handler(ctx, { id: "sheet_raw", fresh: true, limit: 2 });
    expect(fetchBindingTable).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ headers: ["h"], rows: [["1"], ["2"]], total: 3, truncated: true });
  });

  it("read_spreadsheet fetches when there is no cache and refuses another manager's id", async () => {
    fetchBindingTable.mockResolvedValue({ rows: [["h"], ["1"]], error: null });
    const ctx = makeCtx(settings([{ ...rawLink, rawRows: null, rawHeaders: null }]));
    expect(await readSpreadsheetTool.handler(ctx, { id: "sheet_raw" })).toMatchObject({ total: 1 });
    expect(await readSpreadsheetTool.handler(ctx, { id: "nope" })).toHaveProperty("error");
  });

  it("sync_spreadsheet previews, then runs the existing sync and returns its summary", async () => {
    const ctx = makeCtx(settings([rawLink]));
    const preview = await previewWrite(syncSpreadsheetTool, ctx, { id: "sheet_raw" });
    expect(preview.ok).toBe(true);
    syncManagerLinkedSheet.mockResolvedValue({ ok: true, error: null, summary: { warnings: [] } });
    const res = await executeWrite(syncSpreadsheetTool, ctx, { id: "sheet_raw" });
    expect(res.ok).toBe(true);
    expect(syncManagerLinkedSheet).toHaveBeenCalledWith(ctx.db, "manager_a", {
      managerEmail: "manager@axis.test",
      linkId: "sheet_raw",
    });
    expect(res.reply).toContain("Rent roll");
  });

  it("sync_spreadsheet rejects an unknown id", async () => {
    const res = await executeWrite(syncSpreadsheetTool, makeCtx(settings([rawLink])), { id: "nope" });
    expect(res.ok).toBe(false);
  });
});
