import { parseCsv } from "@/lib/sheet-sync/csv";
import { inferHouseKey } from "@/lib/sheet-sync/house-key";
import { spreadsheetExportCsvUrl, spreadsheetHtmlViewUrl } from "@/lib/sheet-sync/url";

export type SheetTabMeta = {
  title: string;
  gid: string;
  houseKey: string | null;
  occupancy: boolean;
};

export type FetchedSheetTab = SheetTabMeta & {
  rows: string[][];
};

const FETCH_MS = 20_000;

async function readText(url: string, accessToken?: string | null): Promise<string | null> {
  const res = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  if (/accounts\.google\.com\/ServiceLogin|<title>Google Sheets<\/title>/i.test(text) && text.includes("<html")) {
    return null;
  }
  return text;
}

export async function fetchSheetCsv(
  spreadsheetId: string,
  gid?: string | null,
): Promise<string[][] | null> {
  const text = await readText(spreadsheetExportCsvUrl(spreadsheetId, gid));
  return text ? parseCsv(text) : null;
}

export function classifySheetTitle(title: string): Pick<SheetTabMeta, "houseKey" | "occupancy"> {
  const occupancy = /resident/i.test(title);
  return { occupancy, houseKey: occupancy ? null : inferHouseKey(title) };
}

export async function listPublicSheetTabs(spreadsheetId: string): Promise<SheetTabMeta[]> {
  const html = await readText(spreadsheetHtmlViewUrl(spreadsheetId));
  if (!html) return [];
  const tabs: SheetTabMeta[] = [];
  const seen = new Set<string>();
  const re = /gid=(\d+)[^>]*>[\s\S]{0,200}?((?:Seattle|Residents|Thrush|Tampa)[^<]{0,40})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const gid = match[1]!;
    const title = match[2]!.replace(/\s+/g, " ").trim();
    if (seen.has(gid) || !title) continue;
    seen.add(gid);
    tabs.push({ title, gid, ...classifySheetTitle(title) });
  }
  if (tabs.length > 0) return tabs;

  const gidOnly = [...html.matchAll(/[?&#]gid=(\d+)/g)].map((m) => m[1]!);
  return [...new Set(gidOnly)].map((gid) => ({
    title: gid,
    gid,
    houseKey: null,
    occupancy: false,
  }));
}

type SheetsApiSheet = {
  properties?: { sheetId?: number; title?: string };
};

export async function listSheetsApiTabs(
  spreadsheetId: string,
  accessToken: string,
): Promise<SheetTabMeta[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { sheets?: SheetsApiSheet[] };
  return (body.sheets ?? [])
    .map((sheet) => {
      const title = sheet.properties?.title?.trim() ?? "";
      const gid = sheet.properties?.sheetId != null ? String(sheet.properties.sheetId) : "";
      if (!title || !gid) return null;
      return { title, gid, ...classifySheetTitle(title) };
    })
    .filter((tab): tab is SheetTabMeta => tab != null);
}

export async function fetchSheetApiValues(
  spreadsheetId: string,
  title: string,
  accessToken: string,
): Promise<string[][] | null> {
  const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { values?: unknown[][] };
  if (!Array.isArray(body.values)) return [];
  return body.values.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []));
}

/**
 * One specific tab's rows, by gid — for a manager-picked stays tab
 * (BUILD-WAVE2 C210), not the whole-workbook occupancy/house-tab sweep
 * `loadWorkbookTabs` does below.
 *
 * Prefers the real Sheets API by title when an access token is available
 * (works for a private, Picker-granted file); falls back to the public CSV
 * export by gid otherwise, same as every other read in this module.
 */
export async function fetchStaysTabRows(
  spreadsheetId: string,
  tab: { gid: string; title: string },
  accessToken?: string | null,
): Promise<string[][] | null> {
  if (accessToken && tab.title) {
    const rows = await fetchSheetApiValues(spreadsheetId, tab.title, accessToken);
    if (rows) return rows;
  }
  return fetchSheetCsv(spreadsheetId, tab.gid);
}

export async function loadWorkbookTabs(input: {
  spreadsheetId: string;
  occupancyGid: string;
  houseTabs: Array<{ label: string; gid: string; houseKey: string }>;
  accessToken?: string | null;
}): Promise<{ occupancy: FetchedSheetTab | null; houses: FetchedSheetTab[]; error: string | null }> {
  const houses: FetchedSheetTab[] = [];
  let occupancy: FetchedSheetTab | null = null;

  if (input.accessToken) {
    const tabs = await listSheetsApiTabs(input.spreadsheetId, input.accessToken);
    for (const tab of tabs) {
      const rows = await fetchSheetApiValues(input.spreadsheetId, tab.title, input.accessToken);
      if (!rows) continue;
      const fetched = { ...tab, rows };
      if (tab.occupancy && !occupancy) occupancy = fetched;
      else if (tab.houseKey) houses.push(fetched);
    }
    if (occupancy || houses.length > 0) return { occupancy, houses, error: null };
  }

  const publicTabs = input.houseTabs.length > 0 ? [] : await listPublicSheetTabs(input.spreadsheetId);
  const occupancyGid = input.occupancyGid || publicTabs.find((tab) => tab.occupancy)?.gid || "";
  if (occupancyGid) {
    const rows = await fetchSheetCsv(input.spreadsheetId, occupancyGid);
    if (rows) {
      occupancy = {
        title: "Residents",
        gid: occupancyGid,
        houseKey: null,
        occupancy: true,
        rows,
      };
    }
  }

  const houseSpecs =
    input.houseTabs.length > 0
      ? input.houseTabs.map((tab) => ({
          title: tab.label,
          gid: tab.gid,
          houseKey: tab.houseKey,
          occupancy: false,
        }))
      : publicTabs.filter((tab) => tab.houseKey);

  for (const tab of houseSpecs) {
    const rows = await fetchSheetCsv(input.spreadsheetId, tab.gid);
    if (!rows) continue;
    houses.push({ ...tab, rows });
  }

  if (!occupancy && houses.length === 0) {
    return {
      occupancy: null,
      houses: [],
      error:
        "Could not read the spreadsheet. Share it with anyone who has the link, or connect Google on the account.",
    };
  }
  return { occupancy, houses, error: null };
}
