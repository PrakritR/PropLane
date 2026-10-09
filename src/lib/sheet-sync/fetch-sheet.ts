import { parseCsv } from "@/lib/sheet-sync/csv";
import { fetchPinnedPublicHttps, resolvesToPublicAddressesOnly } from "@/lib/sheet-sync/public-host.server";
import { inferHouseKey } from "@/lib/sheet-sync/house-key";
import {
  isSafePublicHttpsUrl,
  isValidPublishedCsvUrl,
  spreadsheetExportCsvUrl,
  spreadsheetHtmlViewUrl,
} from "@/lib/sheet-sync/url";

export { isValidPublishedCsvUrl };

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

const CSV_MAX_BYTES = 5 * 1024 * 1024;
const CSV_FETCH_MS = 15_000;
const CSV_MAX_REDIRECTS = 3;

const CSV_GENERIC_ERROR = "Could not read the CSV.";
const CSV_TIMEOUT_ERROR = "The CSV link took too long to answer.";

/** One hop of a published-CSV fetch. The default connects only to a pre-vetted address. */
export type PinnedHopFetcher = (
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number; totalTimeoutMs?: number },
) => Promise<Response>;

/**
 * Fetch a published CSV server-side: https only, public hosts only (every
 * redirect hop is re-checked by name AND by resolved address, and the
 * connection is pinned to the address that was checked, so a public name
 * pointing at — or re-resolving to — a private, loopback, link-local or
 * metadata address is refused), 5 MB cap, 15 s timeout, text/csv or
 * text/plain. Returns the same `string[][]` table the Google path returns.
 *
 * The 15 s is one wall-clock budget for the WHOLE fetch, not per hop: each hop is handed what is
 * left of it, so a host that redirects three times and then trickles bytes cannot hold the route
 * open for four deadlines in a row.
 */
export async function fetchPublishedCsv(
  url: string,
  deps: { fetchHop?: PinnedHopFetcher } = {},
): Promise<{ rows: string[][] | null; error: string | null }> {
  if (!isValidPublishedCsvUrl(url)) {
    return { rows: null, error: "That is not a valid published CSV link (https URL ending in .csv, or a Google pub?output=csv link)." };
  }
  const fetchHop = deps.fetchHop ?? fetchPinnedPublicHttps;
  const deadlineAt = Date.now() + CSV_FETCH_MS;
  const remainingMs = () => deadlineAt - Date.now();
  try {
    let target = url.trim();
    let res: Response | null = null;
    for (let hop = 0; hop <= CSV_MAX_REDIRECTS; hop++) {
      if (remainingMs() <= 0) return { rows: null, error: CSV_TIMEOUT_ERROR };
      if (!(await resolvesToPublicAddressesOnly(new URL(target).hostname))) {
        console.warn("published CSV fetch refused: host resolves to a non-public address", { hop });
        return { rows: null, error: CSV_GENERIC_ERROR };
      }
      const left = remainingMs();
      if (left <= 0) return { rows: null, error: CSV_TIMEOUT_ERROR };
      res = await fetchHop(target, {
        headers: { Accept: "text/csv,text/plain" },
        timeoutMs: left,
        totalTimeoutMs: left,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { rows: null, error: "The CSV link redirected without a destination." };
        const next = new URL(location, target).toString();
        if (!isSafePublicHttpsUrl(next)) {
          console.warn("published CSV fetch refused: redirect to a disallowed URL");
          return { rows: null, error: CSV_GENERIC_ERROR };
        }
        target = next;
        res = null;
        continue;
      }
      break;
    }
    if (!res) return { rows: null, error: "The CSV link redirected too many times." };
    if (!res.ok) return { rows: null, error: `The CSV link answered ${res.status}.` };
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("text/csv") && !type.includes("text/plain")) {
      return { rows: null, error: "The link did not return a CSV (expected text/csv or text/plain)." };
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > CSV_MAX_BYTES) return { rows: null, error: "The CSV is larger than 5 MB." };
    const reader = res.body?.getReader();
    if (!reader) return { rows: null, error: "The CSV link returned no data." };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (remainingMs() <= 0) {
        await reader.cancel().catch(() => undefined);
        return { rows: null, error: CSV_TIMEOUT_ERROR };
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CSV_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { rows: null, error: "The CSV is larger than 5 MB." };
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (!text.trim()) return { rows: null, error: "The CSV is empty." };
    return { rows: parseCsv(text), error: null };
  } catch (e) {
    console.error("published CSV fetch failed", e);
    return { rows: null, error: CSV_GENERIC_ERROR };
  }
}

export type SheetTableSource = {
  source: "google" | "csv";
  csvUrl: string | null;
  spreadsheetId: string;
  occupancyGid: string;
  houseTabs: Array<{ label: string; gid: string; houseKey: string }>;
  staysTab: { gid: string; title: string } | null;
};

/** The tabs this binding is known to have, without any network call. */
export function knownSheetTabs(link: SheetTableSource): Array<{ gid: string; title: string }> {
  if (link.source === "csv") return [{ gid: "0", title: "CSV" }];
  const tabs: Array<{ gid: string; title: string }> = [];
  if (link.occupancyGid) tabs.push({ gid: link.occupancyGid, title: "Residents" });
  for (const tab of link.houseTabs) tabs.push({ gid: tab.gid, title: tab.label });
  if (link.staysTab && !tabs.some((t) => t.gid === link.staysTab!.gid)) {
    tabs.push({ gid: link.staysTab.gid, title: link.staysTab.title || "Stays" });
  }
  return tabs;
}

/**
 * One table from a binding, for raw caching and `read_spreadsheet`. CSV
 * sources fetch the URL; Google sources prefer the Sheets API (private,
 * Picker-granted files) and fall back to the public CSV export. `tab` picks
 * a tab by gid or title; omitted = the first tab. Applies nothing.
 */
export async function fetchBindingTable(
  link: SheetTableSource,
  opts?: { tab?: string | null; accessToken?: string | null },
): Promise<{ rows: string[][] | null; error: string | null }> {
  if (link.source === "csv") {
    return fetchPublishedCsv(link.csvUrl ?? "");
  }
  const wanted = opts?.tab?.trim() ?? "";
  if (opts?.accessToken) {
    const tabs = await listSheetsApiTabs(link.spreadsheetId, opts.accessToken);
    const pick =
      (wanted && tabs.find((t) => t.gid === wanted || t.title.toLowerCase() === wanted.toLowerCase())) ||
      (wanted ? null : tabs[0]);
    if (pick) {
      const rows = await fetchSheetApiValues(link.spreadsheetId, pick.title, opts.accessToken);
      if (rows) return { rows, error: null };
    }
  }
  const known = knownSheetTabs(link);
  const gid = wanted
    ? (known.find((t) => t.gid === wanted || t.title.toLowerCase() === wanted.toLowerCase())?.gid ?? (/^\d+$/.test(wanted) ? wanted : null))
    : null;
  if (wanted && !gid) return { rows: null, error: `No tab named "${wanted}".` };
  const rows = await fetchSheetCsv(link.spreadsheetId, gid);
  return rows
    ? { rows, error: null }
    : { rows: null, error: "Could not read the spreadsheet. Share it with anyone who has the link, or connect Google on the account." };
}
