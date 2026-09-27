import type { SupabaseClient } from "@supabase/supabase-js";

import { AMBIKA_MANAGER_EMAIL } from "@/lib/ambika-seattle-occupancy";
import { canonicalSpreadsheetEditUrl, parseSpreadsheetUrl } from "@/lib/sheet-sync/url";

export const SHEET_LINK_ROW_DATA_KEY = "sheetLink";
export const SHEET_LINKS_ROW_DATA_KEY = "sheetLinks";
export const GOOGLE_SHEETS_ROW_DATA_KEY = "googleSheets";
export const ALL_SHEET_PROPERTIES = "";

export const AMBIKA_SALES_SPREADSHEET_ID = "11FJ3Ugv4CjhJtUk18DU2-CaM6UJQJjSwQ_bzDU-ThJw";
export const AMBIKA_OCCUPANCY_GID = "26223109";

export type ManagerSheetHouseTab = {
  label: string;
  gid: string;
  houseKey: string;
};

/**
 * A manager-picked one-row-per-stay tab (BUILD-WAVE2 C210), additive on top
 * of the existing occupancy-grid + house-tab binding shape. `columnMap` is
 * the manager's own match from the preview screen (falls back to
 * auto-detection when absent); `nameMap` remembers a house spelling the
 * matcher could not resolve on its own, keyed by the sheet's own text.
 */
export type ManagerSheetStaysTab = {
  gid: string;
  title: string;
  columnMap: import("@/lib/sheet-sync/parse-stays-table").StaysTableColumnMap | null;
  nameMap: Record<string, string>;
};

export type ManagerSheetLink = {
  spreadsheetUrl: string;
  spreadsheetId: string;
  occupancyGid: string;
  houseTabs: ManagerSheetHouseTab[];
  autoSync: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastSummary: string | null;
};

export type ManagerSheetBinding = {
  id: string;
  title: string;
  spreadsheetId: string;
  occupancyGid: string;
  houseTabs: ManagerSheetHouseTab[];
  /** Absent = this spreadsheet has no linked stays tab. */
  staysTab: ManagerSheetStaysTab | null;
  workspaceId: string;
  propertyId: string | null;
  autoSync: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastSummary: string | null;
};

export const DEFAULT_MANAGER_SHEET_LINK: ManagerSheetLink = {
  spreadsheetUrl: "",
  spreadsheetId: "",
  occupancyGid: "",
  houseTabs: [],
  autoSync: true,
  lastSyncedAt: null,
  lastError: null,
  lastSummary: null,
};

export type GoogleSheetsConnection = {
  connected: boolean;
  email: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  /** True once a revoked/expired refresh token was detected and the connection was proactively disconnected. */
  revoked?: boolean;
};

export const DEFAULT_GOOGLE_SHEETS_CONNECTION: GoogleSheetsConnection = {
  connected: false,
  email: null,
  refreshToken: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  revoked: false,
};

export function ambikaSuggestedSpreadsheetUrl(): string {
  return canonicalSpreadsheetEditUrl(AMBIKA_SALES_SPREADSHEET_ID, AMBIKA_OCCUPANCY_GID);
}

export function suggestedSpreadsheetUrlForEmail(email: string | null | undefined): string | null {
  return email?.trim().toLowerCase() === AMBIKA_MANAGER_EMAIL ? ambikaSuggestedSpreadsheetUrl() : null;
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function asStaysTab(raw: unknown): ManagerSheetStaysTab | null {
  const row = asObject(raw);
  const gid = typeof row.gid === "string" ? row.gid.trim() : "";
  if (!gid) return null;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const nameMapRaw = asObject(row.nameMap);
  const nameMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(nameMapRaw)) {
    if (typeof value === "string" && value.trim()) nameMap[key] = value.trim();
  }
  const columnMapRaw = row.columnMap;
  const columnMap =
    columnMapRaw && typeof columnMapRaw === "object" && !Array.isArray(columnMapRaw)
      ? (columnMapRaw as ManagerSheetStaysTab["columnMap"])
      : null;
  return { gid, title, columnMap, nameMap };
}

function asHouseTabs(raw: unknown): ManagerSheetHouseTab[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = asObject(item);
      const label = typeof row.label === "string" ? row.label.trim() : "";
      const gid = typeof row.gid === "string" ? row.gid.trim() : "";
      const houseKey = typeof row.houseKey === "string" ? row.houseKey.trim() : "";
      if (!gid || !houseKey) return null;
      return { label: label || houseKey, gid, houseKey };
    })
    .filter((tab): tab is ManagerSheetHouseTab => tab != null);
}

export function normalizeManagerSheetLink(raw: unknown): ManagerSheetLink {
  const row = asObject(raw);
  const parsed = typeof row.spreadsheetUrl === "string" ? parseSpreadsheetUrl(row.spreadsheetUrl) : null;
  const spreadsheetId =
    (typeof row.spreadsheetId === "string" && row.spreadsheetId.trim()) || parsed?.spreadsheetId || "";
  const occupancyGid =
    (typeof row.occupancyGid === "string" && row.occupancyGid.trim()) || parsed?.gid || "";
  const spreadsheetUrl =
    typeof row.spreadsheetUrl === "string" && row.spreadsheetUrl.trim()
      ? row.spreadsheetUrl.trim()
      : spreadsheetId
        ? canonicalSpreadsheetEditUrl(spreadsheetId, occupancyGid || null)
        : "";
  return {
    spreadsheetUrl,
    spreadsheetId,
    occupancyGid,
    houseTabs: asHouseTabs(row.houseTabs),
    autoSync: row.autoSync !== false,
    lastSyncedAt: typeof row.lastSyncedAt === "string" && row.lastSyncedAt.trim() ? row.lastSyncedAt : null,
    lastError: typeof row.lastError === "string" && row.lastError.trim() ? row.lastError : null,
    lastSummary: typeof row.lastSummary === "string" && row.lastSummary.trim() ? row.lastSummary : null,
  };
}

export function sheetLinkFromUrl(url: string, previous?: ManagerSheetLink | null): ManagerSheetLink {
  const parsed = parseSpreadsheetUrl(url);
  const base = previous ?? DEFAULT_MANAGER_SHEET_LINK;
  if (!parsed) {
    return { ...base, spreadsheetUrl: url.trim(), spreadsheetId: "", occupancyGid: base.occupancyGid };
  }
  const occupancyGid = parsed.gid || base.occupancyGid || "";
  return {
    ...base,
    spreadsheetUrl: parsed.url,
    spreadsheetId: parsed.spreadsheetId,
    occupancyGid,
  };
}

export function publicManagerSheetLink(link: ManagerSheetLink) {
  return {
    spreadsheetUrl: link.spreadsheetUrl,
    spreadsheetId: link.spreadsheetId,
    occupancyGid: link.occupancyGid,
    autoSync: link.autoSync,
    lastSyncedAt: link.lastSyncedAt,
    lastError: link.lastError,
    lastSummary: link.lastSummary,
    linked: Boolean(link.spreadsheetId),
  };
}

export function newSheetBindingId(): string {
  return `sheet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function occupancyGidForSpreadsheet(spreadsheetId: string, previous?: string): string {
  if (previous?.trim()) return previous.trim();
  return spreadsheetId === AMBIKA_SALES_SPREADSHEET_ID ? AMBIKA_OCCUPANCY_GID : "";
}

export function normalizeManagerSheetBinding(raw: unknown): ManagerSheetBinding | null {
  const row = asObject(raw);
  const spreadsheetId = typeof row.spreadsheetId === "string" ? row.spreadsheetId.trim() : "";
  if (!spreadsheetId) return null;
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : newSheetBindingId();
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Spreadsheet";
  const workspaceId = typeof row.workspaceId === "string" ? row.workspaceId.trim() : "";
  const propertyRaw = typeof row.propertyId === "string" ? row.propertyId.trim() : "";
  return {
    id,
    title,
    spreadsheetId,
    occupancyGid: occupancyGidForSpreadsheet(
      spreadsheetId,
      typeof row.occupancyGid === "string" ? row.occupancyGid : "",
    ),
    houseTabs: asHouseTabs(row.houseTabs),
    staysTab: asStaysTab(row.staysTab),
    workspaceId,
    propertyId: propertyRaw && propertyRaw !== ALL_SHEET_PROPERTIES ? propertyRaw : null,
    autoSync: row.autoSync !== false,
    lastSyncedAt: typeof row.lastSyncedAt === "string" && row.lastSyncedAt.trim() ? row.lastSyncedAt : null,
    lastError: typeof row.lastError === "string" && row.lastError.trim() ? row.lastError : null,
    lastSummary: typeof row.lastSummary === "string" && row.lastSummary.trim() ? row.lastSummary : null,
  };
}

export function bindingFromLegacyLink(link: ManagerSheetLink): ManagerSheetBinding | null {
  if (!link.spreadsheetId) return null;
  return {
    id: "sheet_legacy",
    title: "Spreadsheet",
    spreadsheetId: link.spreadsheetId,
    occupancyGid: occupancyGidForSpreadsheet(link.spreadsheetId, link.occupancyGid),
    houseTabs: link.houseTabs,
    staysTab: null,
    workspaceId: "",
    propertyId: null,
    autoSync: link.autoSync,
    lastSyncedAt: link.lastSyncedAt,
    lastError: link.lastError,
    lastSummary: link.lastSummary,
  };
}

export function normalizeManagerSheetBindings(rowData: unknown): ManagerSheetBinding[] {
  const data = asObject(rowData);
  const raw = data[SHEET_LINKS_ROW_DATA_KEY];
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(normalizeManagerSheetBinding).filter((row): row is ManagerSheetBinding => row != null);
  }
  const legacy = bindingFromLegacyLink(normalizeManagerSheetLink(data[SHEET_LINK_ROW_DATA_KEY]));
  return legacy ? [legacy] : [];
}

export function publicManagerSheetBinding(link: ManagerSheetBinding) {
  return {
    id: link.id,
    title: link.title,
    spreadsheetId: link.spreadsheetId,
    workspaceId: link.workspaceId,
    propertyId: link.propertyId,
    autoSync: link.autoSync,
    lastSyncedAt: link.lastSyncedAt,
    lastError: link.lastError,
    lastSummary: link.lastSummary,
    linked: Boolean(link.spreadsheetId),
    staysTab: link.staysTab ? { gid: link.staysTab.gid, title: link.staysTab.title } : null,
  };
}

export function sheetBindingAppliesToProperty(
  link: ManagerSheetBinding,
  propertyId: string | null | undefined,
  workspacePropertyIds?: readonly string[] | null,
): boolean {
  if (!propertyId) return true;
  if (link.propertyId) return link.propertyId === propertyId;
  if (link.workspaceId && workspacePropertyIds) return workspacePropertyIds.includes(propertyId);
  return true;
}

export function normalizeGoogleSheetsConnection(raw: unknown): GoogleSheetsConnection {
  const row = asObject(raw);
  const refreshToken = typeof row.refreshToken === "string" && row.refreshToken.trim() ? row.refreshToken : null;
  return {
    connected: row.connected === true && Boolean(refreshToken),
    email: typeof row.email === "string" && row.email.trim() ? row.email.trim() : null,
    refreshToken,
    accessToken: typeof row.accessToken === "string" && row.accessToken.trim() ? row.accessToken : null,
    accessTokenExpiresAt:
      typeof row.accessTokenExpiresAt === "string" && row.accessTokenExpiresAt.trim()
        ? row.accessTokenExpiresAt
        : null,
    revoked: row.revoked === true,
  };
}

function rowDataOf(raw: unknown): Record<string, unknown> {
  return asObject(raw);
}

async function loadAutomationRowData(db: SupabaseClient, managerUserId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return rowDataOf(data?.row_data);
}

async function saveAutomationRowData(
  db: SupabaseClient,
  managerUserId: string,
  rowData: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
}

export async function loadManagerSheetLink(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerSheetLink> {
  const rowData = await loadAutomationRowData(db, managerUserId);
  return normalizeManagerSheetLink(rowData[SHEET_LINK_ROW_DATA_KEY]);
}

export async function loadManagerSheetBindings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerSheetBinding[]> {
  return normalizeManagerSheetBindings(await loadAutomationRowData(db, managerUserId));
}

export async function saveManagerSheetLink(
  db: SupabaseClient,
  managerUserId: string,
  link: ManagerSheetLink,
): Promise<ManagerSheetLink> {
  const normalized = normalizeManagerSheetLink(link);
  const rowData = await loadAutomationRowData(db, managerUserId);
  rowData[SHEET_LINK_ROW_DATA_KEY] = normalized;
  const bindings = normalizeManagerSheetBindings(rowData);
  const migrated = bindingFromLegacyLink(normalized);
  if (migrated && bindings.every((row) => row.spreadsheetId !== normalized.spreadsheetId)) {
    rowData[SHEET_LINKS_ROW_DATA_KEY] = [...bindings, migrated];
  }
  await saveAutomationRowData(db, managerUserId, rowData);
  return normalized;
}

export async function saveManagerSheetBindings(
  db: SupabaseClient,
  managerUserId: string,
  bindings: ManagerSheetBinding[],
): Promise<ManagerSheetBinding[]> {
  const normalized = bindings
    .map(normalizeManagerSheetBinding)
    .filter((row): row is ManagerSheetBinding => row != null);
  const rowData = await loadAutomationRowData(db, managerUserId);
  rowData[SHEET_LINKS_ROW_DATA_KEY] = normalized;
  const first = normalized[0];
  rowData[SHEET_LINK_ROW_DATA_KEY] = first
    ? {
        ...DEFAULT_MANAGER_SHEET_LINK,
        spreadsheetId: first.spreadsheetId,
        spreadsheetUrl: canonicalSpreadsheetEditUrl(first.spreadsheetId, first.occupancyGid || null),
        occupancyGid: first.occupancyGid,
        houseTabs: first.houseTabs,
        autoSync: first.autoSync,
        lastSyncedAt: first.lastSyncedAt,
        lastError: first.lastError,
        lastSummary: first.lastSummary,
      }
    : DEFAULT_MANAGER_SHEET_LINK;
  await saveAutomationRowData(db, managerUserId, rowData);
  return normalized;
}

export async function loadGoogleSheetsConnection(
  db: SupabaseClient,
  managerUserId: string,
): Promise<GoogleSheetsConnection> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeGoogleSheetsConnection(rowDataOf(data?.row_data)[GOOGLE_SHEETS_ROW_DATA_KEY]);
}

export async function saveGoogleSheetsConnection(
  db: SupabaseClient,
  managerUserId: string,
  patch: Partial<GoogleSheetsConnection>,
): Promise<GoogleSheetsConnection> {
  const current = await loadGoogleSheetsConnection(db, managerUserId);
  const next = normalizeGoogleSheetsConnection({ ...current, ...patch });
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData = rowDataOf(existing?.row_data);
  rowData[GOOGLE_SHEETS_ROW_DATA_KEY] = next;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return next;
}

export async function listManagersWithSheetLinks(
  db: SupabaseClient,
): Promise<Array<{ managerUserId: string; bindings: ManagerSheetBinding[] }>> {
  const { data, error } = await db.from("manager_automation_settings").select("manager_user_id, row_data");
  if (error) throw error;
  const out: Array<{ managerUserId: string; bindings: ManagerSheetBinding[] }> = [];
  for (const row of data ?? []) {
    const bindings = normalizeManagerSheetBindings(row.row_data).filter((link) => link.autoSync && link.spreadsheetId);
    if (bindings.length === 0) continue;
    out.push({ managerUserId: String(row.manager_user_id), bindings });
  }
  return out;
}
