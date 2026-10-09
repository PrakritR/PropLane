import { z } from "zod";

import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import { propertyInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import {
  loadManagerSheetBindings,
  type ManagerSheetBinding,
} from "@/lib/manager-sheet-link";
import { syncManagerLinkedSheet } from "@/lib/sheet-sync/apply.server";
import { fetchBindingTable, knownSheetTabs } from "@/lib/sheet-sync/fetch-sheet";
import { getGoogleSheetsAccessToken } from "@/lib/sheet-sync/google-sheets-auth";

const NOT_FOUND = "No spreadsheet with that id. Call list_spreadsheets for the ids.";

/** A binding is visible when it has no workspace or sits in the active one. */
function visibleInWorkspace(ctx: AgentContext, link: ManagerSheetBinding): boolean {
  if (!ctx.workspace || !ctx.workspace.narrowing) return true;
  if (!link.workspaceId) return propertyInAgentWorkspace(ctx.workspace, null);
  return link.workspaceId === ctx.workspace.id;
}

async function loadVisibleBindings(ctx: AgentContext): Promise<ManagerSheetBinding[]> {
  const all = await loadManagerSheetBindings(ctx.db, ctx.landlordId);
  return all.filter((link) => visibleInWorkspace(ctx, link));
}

async function loadVisibleBinding(ctx: AgentContext, id: string): Promise<ManagerSheetBinding | null> {
  return (await loadVisibleBindings(ctx)).find((link) => link.id === id) ?? null;
}

export const listSpreadsheetsTool = defineTool({
  name: "list_spreadsheets",
  description:
    "List the spreadsheets linked in Settings > Integrations > Spreadsheets: id, title, source (google | csv), mode (stays | occupancy | raw), refresh interval, last sync time, last error or summary, and known tabs. Use the id with read_spreadsheet or sync_spreadsheet.",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const links = await loadVisibleBindings(ctx);
    return links.map((link) => ({
      id: link.id,
      title: link.title,
      source: link.source,
      mode: link.mode,
      refreshMinutes: link.refreshMinutes,
      lastSyncedAt: link.lastSyncedAt,
      lastError: link.lastError,
      lastSummary: link.lastSummary,
      tabs: knownSheetTabs(link),
    }));
  },
});

export const readSpreadsheetTool = defineTool({
  name: "read_spreadsheet",
  description:
    "Read rows from a linked spreadsheet. Serves the cached copy for Raw table sheets; fetches live when fresh is true or nothing is cached. Reads only: nothing is applied to PropLane records. Page with limit/offset; tab is a tab title or gid (default first tab).",
  inputSchema: z
    .object({
      id: z.string().min(1).describe("Spreadsheet id from list_spreadsheets."),
      tab: z.string().min(1).optional().describe("Tab title or gid. Default: the first tab."),
      limit: z.number().int().min(1).max(1000).optional().describe("Rows to return. Default 200."),
      offset: z.number().int().min(0).optional().describe("Rows to skip. Default 0."),
      fresh: z.boolean().optional().describe("Fetch live instead of the cache. Default false."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const link = await loadVisibleBinding(ctx, input.id.trim());
    if (!link) return { error: NOT_FOUND };
    const limit = input.limit ?? 200;
    const offset = input.offset ?? 0;

    let headers: string[];
    let body: string[][];
    let fetchedAt: string;
    let truncated = false;

    const cached = link.rawRows && link.rawHeaders && !input.tab && !input.fresh;
    if (cached) {
      headers = link.rawHeaders!;
      body = link.rawRows!;
      fetchedAt = link.rawFetchedAt ?? link.lastSyncedAt ?? "";
      truncated = /truncated/i.test(link.lastSummary ?? "");
    } else {
      const accessToken = link.source === "csv" ? null : await getGoogleSheetsAccessToken(ctx.db, ctx.landlordId);
      const fetched = await fetchBindingTable(link, { tab: input.tab ?? null, accessToken });
      if (!fetched.rows) return { error: fetched.error ?? "Could not read the spreadsheet." };
      headers = fetched.rows[0] ?? [];
      body = fetched.rows.slice(1);
      fetchedAt = new Date().toISOString();
    }

    const rows = body.slice(offset, offset + limit);
    return {
      headers,
      rows,
      total: body.length,
      fetchedAt,
      truncated: truncated || offset + rows.length < body.length,
    };
  },
});

export const syncSpreadsheetTool = defineWriteTool({
  name: "sync_spreadsheet",
  description:
    "Run the sync for one linked spreadsheet now and return its result summary. For stays and occupancy sheets this updates PropLane bookings and house details; for Raw table sheets it refreshes the cached rows.",
  inputSchema: z
    .object({
      id: z.string().min(1).describe("Spreadsheet id from list_spreadsheets."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const link = await loadVisibleBinding(ctx, input.id.trim());
    if (!link) throw new Error(NOT_FOUND);
    return {
      kind: "sync_spreadsheet",
      title: "Sync spreadsheet",
      summary: `Sync "${link.title}" now.`,
      fields: [
        { label: "Spreadsheet", value: link.title },
        { label: "Reads as", value: link.mode === "raw" ? "Raw table" : link.mode === "stays" ? "Stays" : "Occupancy grid" },
      ],
      confirmLabel: "Sync now",
      ...(link.mode !== "raw"
        ? { warnings: ["This updates PropLane bookings and house details from the sheet."] }
        : {}),
    };
  },
  handler: async (ctx, input) => {
    const id = input.id.trim();
    const link = await loadVisibleBinding(ctx, id);
    if (!link) throw new Error(NOT_FOUND);

    await writeAuditLog(ctx, {
      action: "sync_spreadsheet",
      toolName: "sync_spreadsheet",
      inputSummary: { id, mode: link.mode, source: link.source },
    });

    const result = await syncManagerLinkedSheet(ctx.db, ctx.landlordId, { managerEmail: ctx.email, linkId: id });
    const after = await loadVisibleBinding(ctx, id);
    const summary = after?.lastSummary ?? null;
    if (!result.ok) {
      throw new Error(result.error ?? "Could not sync the spreadsheet.");
    }
    return {
      reply: `Synced "${link.title}"${summary ? `: ${summary}` : ""}.`,
      resultSummary: { id, summary, warnings: result.summary.warnings.length },
    };
  },
});
