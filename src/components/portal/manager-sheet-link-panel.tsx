"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Plus, Sheet } from "lucide-react";

import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { GoogleSpreadsheetPicker } from "@/components/portal/google-spreadsheet-picker";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
} from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { formatGoogleCalendarConnectError } from "@/lib/google-calendar/connect-errors";
import {
  ALL_SHEET_PROPERTIES,
  sheetLinkReadsLabel,
  sheetLinkStatus,
  type SheetMode,
  type SheetRefreshMinutes,
  type SheetSource,
  type SheetLinkStatus,
} from "@/lib/manager-sheet-link";
import { isValidPublishedCsvUrl } from "@/lib/sheet-sync/url";
import { Input } from "@/components/ui/input";
import { SegmentedTwo } from "@/components/ui/segmented-control";

type PublicSheetBinding = {
  id: string;
  title: string;
  spreadsheetId: string;
  workspaceId: string;
  propertyId: string | null;
  autoSync: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastSummary: string | null;
  linked: boolean;
  staysTab: { gid: string; title: string } | null;
  source: SheetSource;
  csvUrl: string | null;
  mode: SheetMode;
  refreshMinutes: SheetRefreshMinutes;
  houseTabCount: number;
};

const STATUS_LABEL: Record<SheetLinkStatus, string> = { live: "Live", attention: "Needs attention", manual: "Manual" };
const STATUS_CLASS: Record<SheetLinkStatus, string> = {
  live: "bg-emerald-500/15 text-emerald-700",
  attention: "bg-amber-500/15 text-amber-700",
  manual: "bg-card text-muted",
};

const MODE_OPTIONS: Array<{ value: SheetMode; label: string }> = [
  { value: "stays", label: "Stays" },
  { value: "occupancy", label: "Occupancy grid" },
  { value: "raw", label: "Raw table" },
];
const REFRESH_OPTIONS = [
  { value: "15", label: "Every 15 minutes" },
  { value: "60", label: "Hourly" },
  { value: "manual", label: "Manual only" },
];

function refreshFromOption(value: string): SheetRefreshMinutes {
  return value === "15" ? 15 : value === "60" ? 60 : null;
}

function refreshToOption(value: SheetRefreshMinutes): string {
  return value == null ? "manual" : String(value);
}

type StaysTabOption = { gid: string; title: string };

type StaysPreview = {
  stayCount: number;
  houseCount: number;
  roomCount: number;
  skipped: number;
  unmatchedHouses: { houseRaw: string; count: number }[];
  readyToLink: boolean;
  columnMap: unknown;
};

type SheetLinkResponse = {
  links: PublicSheetBinding[];
  sheets: { connected: boolean; email: string | null; configured: boolean };
};

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeStamp(iso: string | null, now: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "never";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return formatStamp(iso);
}

function SheetStatusLine({ link, now }: { link: PublicSheetBinding; now: number }) {
  const status = sheetLinkStatus(link, new Date(now));
  const parts = [
    link.source === "csv" ? "Published CSV" : "Google Sheet",
    sheetLinkReadsLabel(link),
    `synced ${relativeStamp(link.lastSyncedAt, now)}`,
    link.lastError ?? link.lastSummary,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" data-attr="manager-sheet-status">
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      <span>{parts.join(" · ")}</span>
    </span>
  );
}

export function ManagerSheetLinkPanel() {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const workspaceCtx = useWorkspaces();
  const workspaceList = workspaceCtx?.workspaces ?? [];
  const activeWorkspace = workspaceCtx?.active ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [payload, setPayload] = useState<SheetLinkResponse | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTargetId, setPickerTargetId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  // Add a spreadsheet: source, what it reads as, how often it refreshes.
  const [renderedAt] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [addSource, setAddSource] = useState<SheetSource>("google");
  const [addMode, setAddMode] = useState<SheetMode>("stays");
  const [addRefresh, setAddRefresh] = useState<SheetRefreshMinutes>(15);
  const [addCsvUrl, setAddCsvUrl] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  // Stays tab picker (BUILD-WAVE2 C210/C213): which link row's picker is open,
  // the sheet's own tab list, the chosen tab, and its preview counts.
  const [staysPickerLinkId, setStaysPickerLinkId] = useState<string | null>(null);
  const [staysTabs, setStaysTabs] = useState<StaysTabOption[]>([]);
  const [staysTabsLoading, setStaysTabsLoading] = useState(false);
  const [staysSelectedGid, setStaysSelectedGid] = useState<string>("");
  const [staysPreview, setStaysPreview] = useState<StaysPreview | null>(null);
  const [staysPreviewLoading, setStaysPreviewLoading] = useState(false);
  const [staysLinking, setStaysLinking] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/portal/sheet-link", { credentials: "include", cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<SheetLinkResponse>;
    if (!Array.isArray(data.links) || !data.sheets) return;
    setPayload(data as SheetLinkResponse);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gsheet = params.get("gsheet");
    if (!gsheet) return;
    if (gsheet === "connected") showToast("Google Sheets connected.");
    if (gsheet === "error") {
      const reason = params.get("reason");
      const redirectGuess = `${window.location.origin}/api/portal/google-calendar/callback`;
      showToast(
        formatGoogleCalendarConnectError(reason, { oauthRedirectUri: redirectGuess }).replace(
          "Google Calendar",
          "Google Sheets",
        ),
      );
    }
    params.delete("gsheet");
    params.delete("reason");
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
    void load();
  }, [load, showToast]);

  const connectGoogle = () => {
    const origin = encodeURIComponent(window.location.origin);
    const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.assign(`/api/portal/google-sheets/connect?origin=${origin}&returnTo=${returnTo}`);
  };

  const disconnectGoogle = async () => {
    const ok = await confirm({
      title: "Disconnect Google",
      description: payload?.sheets.email || "Disconnect this Google account?",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    const res = await fetch("/api/portal/sheet-link?google=1", { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      showToast("Could not disconnect Google.");
      return;
    }
    showToast("Google disconnected.");
    void load();
  };

  const patchLink = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch("/api/portal/sheet-link", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string; links?: PublicSheetBinding[] } | null;
    if (!res.ok) {
      showToast(data?.error || "Could not save.");
      return;
    }
    if (data?.links) setPayload((prev) => (prev ? { ...prev, links: data.links! } : prev));
  };

  const createLink = async (body: Record<string, unknown>): Promise<boolean> => {
    const defaultWorkspace = activeWorkspace?.id ?? workspaceList[0]?.id ?? "";
    const res = await fetch("/api/portal/sheet-link", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: defaultWorkspace,
        propertyId: ALL_SHEET_PROPERTIES,
        mode: addMode,
        refreshMinutes: addRefresh,
        ...body,
      }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string; links?: PublicSheetBinding[] } | null;
    if (!res.ok) {
      showToast(data?.error || "Could not add the spreadsheet.");
      return false;
    }
    if (data?.links) setPayload((prev) => (prev ? { ...prev, links: data.links! } : prev));
    return true;
  };

  const addSheet = async (sheet: { id: string; name: string }) => {
    if (pickerTargetId) {
      await patchLink(pickerTargetId, { spreadsheetId: sheet.id, title: sheet.name });
      setPickerTargetId(null);
      return;
    }
    if (await createLink({ source: "google", spreadsheetId: sheet.id, title: sheet.name })) setAddOpen(false);
  };

  const addCsv = async () => {
    setAddSaving(true);
    try {
      const url = addCsvUrl.trim();
      let title = "Published CSV";
      try {
        title = new URL(url).hostname;
      } catch {
        /* validated server-side */
      }
      if (await createLink({ source: "csv", csvUrl: url, title })) {
        setAddOpen(false);
        setAddCsvUrl("");
      }
    } finally {
      setAddSaving(false);
    }
  };

  const removeLink = async (link: PublicSheetBinding) => {
    const ok = await confirm({
      title: "Remove spreadsheet",
      description: link.title,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const res = await fetch(`/api/portal/sheet-link?id=${encodeURIComponent(link.id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const data = (await res.json().catch(() => null)) as { links?: PublicSheetBinding[] } | null;
    if (!res.ok) {
      showToast("Could not remove.");
      return;
    }
    if (data?.links) setPayload((prev) => (prev ? { ...prev, links: data.links! } : prev));
  };

  const updateFromSheet = async (linkId: string) => {
    setSyncingId(linkId);
    try {
      const res = await fetch("/api/portal/sheet-sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        showToast(body?.error || "Could not update from the sheet.");
        return;
      }
      showToast("Updated from the sheet.");
      void load();
      window.dispatchEvent(new Event("axis:room-date-blocks-changed"));
    } finally {
      setSyncingId(null);
    }
  };

  const openStaysPicker = async (link: PublicSheetBinding) => {
    setStaysPickerLinkId(link.id);
    setStaysSelectedGid(link.staysTab?.gid ?? "");
    setStaysPreview(null);
    setStaysTabsLoading(true);
    try {
      const res = await fetch("/api/portal/sheet-link/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetId: link.spreadsheetId }),
      });
      const data = (await res.json().catch(() => null)) as { tabs?: StaysTabOption[]; error?: string } | null;
      if (!res.ok) {
        showToast(data?.error || "Could not read this spreadsheet's tabs.");
        setStaysPickerLinkId(null);
        return;
      }
      setStaysTabs(data?.tabs ?? []);
    } finally {
      setStaysTabsLoading(false);
    }
  };

  const closeStaysPicker = () => {
    setStaysPickerLinkId(null);
    setStaysTabs([]);
    setStaysSelectedGid("");
    setStaysPreview(null);
  };

  const previewStaysTab = async (link: PublicSheetBinding, gid: string) => {
    setStaysSelectedGid(gid);
    setStaysPreview(null);
    const tab = staysTabs.find((row) => row.gid === gid);
    if (!tab) return;
    setStaysPreviewLoading(true);
    try {
      const res = await fetch("/api/portal/sheet-link/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spreadsheetId: link.spreadsheetId, gid: tab.gid, title: tab.title }),
      });
      const data = (await res.json().catch(() => null)) as (StaysPreview & { error?: string }) | null;
      if (!res.ok) {
        showToast(data?.error || "Could not read that tab.");
        return;
      }
      if (data) setStaysPreview(data);
    } finally {
      setStaysPreviewLoading(false);
    }
  };

  const linkStaysTab = async (link: PublicSheetBinding) => {
    const tab = staysTabs.find((row) => row.gid === staysSelectedGid);
    if (!tab || !staysPreview) return;
    setStaysLinking(true);
    try {
      await patchLink(link.id, {
        staysTab: { gid: tab.gid, title: tab.title, columnMap: staysPreview.columnMap, nameMap: {} },
      });
      showToast(`${staysPreview.stayCount} stays linked from your sheet.`);
      closeStaysPicker();
      void load();
    } finally {
      setStaysLinking(false);
    }
  };

  const unlinkStaysTab = async (link: PublicSheetBinding) => {
    await patchLink(link.id, { staysTab: null });
    showToast("Stays tab unlinked.");
  };

  const workspaceOptions = useMemo(
    () => workspaceList.map((row) => ({ value: row.id, label: row.name })),
    [workspaceList],
  );

  const propertyOptionsFor = (workspaceId: string) => {
    const workspace = workspaceList.find((row) => row.id === workspaceId);
    const houses = (workspace?.propertyIds ?? []).map((id) => ({
      value: id,
      label: workspace?.propertyLabels?.[id] ?? id,
    }));
    return [{ value: ALL_SHEET_PROPERTIES, label: "All" }, ...houses];
  };

  const links = (payload?.links ?? []).filter((link) => !activeWorkspace || link.workspaceId === activeWorkspace.id);
  const sheets = payload?.sheets;
  const googleConnected = Boolean(sheets?.connected);

  return (
    <PortalSettingsSections>
      <PortalSettingsGroup>
        <GoogleCalendarConnectPanel presentation="row" />
        <PortalSettingsRow label={<span className="flex items-center gap-3"><Sheet className="h-5 w-5 text-emerald-600" />Google Sheets</span>}>
          <div className="flex items-center gap-2"><span className="hidden text-xs text-muted sm:inline">{googleConnected ? `Connected · ${sheets?.email ?? ""}` : ""}</span>
          <Button variant="ghost" disabled={!payload || sheets?.configured === false} onClick={googleConnected ? () => disconnectGoogle() : connectGoogle}>{googleConnected ? "Disconnect" : "Connect"}</Button></div>
        </PortalSettingsRow>
        {links.map((link) => <PortalSettingsRow key={link.id} label={<span className="flex flex-col gap-1 pl-4"><span className="flex items-center gap-3"><Sheet className="h-4 w-4 text-emerald-600" />{link.title}</span><SheetStatusLine link={link} now={renderedAt} /></span>}>
          <div className="flex items-center gap-2"><DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${link.title} actions`} /></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!link.linked || syncingId === link.id} onSelect={() => { void updateFromSheet(link.id); }}>Update now</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditingId(link.id)}>Settings</DropdownMenuItem>
          <DropdownMenuItem className="text-danger" onSelect={() => { void removeLink(link); }}>Remove</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu></div>
        </PortalSettingsRow>)}
        <PortalSettingsRow label="Add a spreadsheet">
          <PortalIconAction icon={Plus} label="Add a spreadsheet" onClick={() => setAddOpen(true)} data-attr="manager-sheet-add" />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      <PortalDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a spreadsheet"
        primaryAction={
          addSource === "csv"
            ? { label: "Add CSV", onClick: addCsv, disabled: addSaving || !isValidPublishedCsvUrl(addCsvUrl), dataAttr: "manager-sheet-add-csv" }
            : googleConnected
              ? { label: "Choose spreadsheet", onClick: () => { setPickerTargetId(null); setPickerOpen(true); }, dataAttr: "manager-sheet-add-google" }
              : { label: "Connect Google", onClick: connectGoogle, disabled: !payload || sheets?.configured === false }
        }
      >
        <PortalSettingsGroup>
          <PortalSettingsRow label="Source">
            <SegmentedTwo
              value={addSource}
              onChange={setAddSource}
              left={{ id: "google", label: "Google Sheet" }}
              right={{ id: "csv", label: "Published CSV link" }}
            />
          </PortalSettingsRow>
          {addSource === "csv" ? (
            <PortalSettingsRow label="CSV link">
              <Input
                value={addCsvUrl}
                onChange={(e) => setAddCsvUrl(e.target.value)}
                placeholder="https://…/pub?output=csv"
                inputMode="url"
                data-attr="manager-sheet-csv-url"
              />
            </PortalSettingsRow>
          ) : null}
          <PortalSettingsRow label="Reads as">
            <FieldSingleSelect
              hideLabel
              label="Reads as"
              value={addMode}
              options={MODE_OPTIONS}
              onChange={(value) => setAddMode(value as SheetMode)}
              dataAttr="manager-sheet-mode"
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Refresh">
            <FieldSingleSelect
              hideLabel
              label="Refresh"
              value={refreshToOption(addRefresh)}
              options={REFRESH_OPTIONS}
              onChange={(value) => setAddRefresh(refreshFromOption(value))}
              dataAttr="manager-sheet-refresh"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalDialog>
      <PortalDialog open={Boolean(editingId)} onClose={() => setEditingId(null)} title="Spreadsheet settings" primaryAction={null}>

      {links.filter((link) => link.id === editingId).map((link) => (
        <PortalSettingsSection
          key={link.id}
          title={link.title}
          action={
            <PortalIconAction
              icon={MoreHorizontal}
              label="Remove"
              onClick={() => removeLink(link)}
              data-attr="manager-sheet-remove"
            />
          }
        >
          <PortalSettingsGroup>
            <PortalSettingsRow label="Spreadsheet">
              <Button
                type="button"
                variant="secondary"
                disabled={!googleConnected || link.source === "csv"}
                onClick={() => {
                  setPickerTargetId(link.id);
                  setPickerOpen(true);
                }}
              >
                Change
              </Button>
            </PortalSettingsRow>
            <PortalSettingsRow label="Workspace">
              <FieldSingleSelect
                hideLabel
                label="Workspace"
                value={link.workspaceId}
                options={workspaceOptions}
                onChange={(workspaceId) => patchLink(link.id, { workspaceId, propertyId: ALL_SHEET_PROPERTIES })}
                dataAttr="manager-sheet-workspace"
              />
            </PortalSettingsRow>
            <PortalSettingsRow label="Property">
              <FieldSingleSelect
                hideLabel
                label="Property"
                value={link.propertyId ?? ALL_SHEET_PROPERTIES}
                options={propertyOptionsFor(link.workspaceId)}
                onChange={(propertyId) => patchLink(link.id, { propertyId })}
                dataAttr="manager-sheet-property"
              />
            </PortalSettingsRow>
            <PortalSettingsRow label="Reads as">
              <FieldSingleSelect
                hideLabel
                label="Reads as"
                value={link.mode}
                options={MODE_OPTIONS}
                onChange={(mode) => patchLink(link.id, { mode })}
                dataAttr="manager-sheet-edit-mode"
              />
            </PortalSettingsRow>
            <PortalSettingsRow label="Refresh">
              <FieldSingleSelect
                hideLabel
                label="Refresh"
                value={refreshToOption(link.refreshMinutes)}
                options={REFRESH_OPTIONS}
                onChange={(value) => patchLink(link.id, { refreshMinutes: refreshFromOption(value) })}
                dataAttr="manager-sheet-auto-sync"
              />
            </PortalSettingsRow>
            <PortalSettingsRow label="Last update">{formatStamp(link.lastSyncedAt)}</PortalSettingsRow>
            {link.lastSummary ? <PortalSettingsRow label="Result">{link.lastSummary}</PortalSettingsRow> : null}
            {link.lastError ? <PortalSettingsRow label="Note">{link.lastError}</PortalSettingsRow> : null}
            <PortalSettingsRow label="Update">
              <Button
                type="button"
                variant="primary"
                disabled={!link.linked || syncingId === link.id}
                onClick={() => updateFromSheet(link.id)}
                data-attr="manager-sheet-update"
              >
                Update from sheet
              </Button>
            </PortalSettingsRow>
            <PortalSettingsRow label="Stays tab">
              {link.staysTab ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{link.staysTab.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => unlinkStaysTab(link)}
                    data-attr="manager-sheet-stays-unlink"
                  >
                    Unlink
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!link.linked || !googleConnected || link.source === "csv"}
                  onClick={() => openStaysPicker(link)}
                  data-attr="manager-sheet-stays-open"
                >
                  Link a Stays tab
                </Button>
              )}
            </PortalSettingsRow>
            {staysPickerLinkId === link.id ? (
              <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/60 p-3" data-attr="manager-sheet-stays-picker">
                {staysTabsLoading ? (
                  <p className="text-sm text-muted">Reading the spreadsheet&apos;s tabs…</p>
                ) : staysTabs.length === 0 ? (
                  <p className="text-sm text-muted">No tabs found on this spreadsheet.</p>
                ) : (
                  <>
                    <FieldSingleSelect
                      hideLabel
                      label="Tab"
                      value={staysSelectedGid}
                      options={staysTabs.map((tab) => ({ value: tab.gid, label: tab.title }))}
                      onChange={(gid) => void previewStaysTab(link, gid)}
                      dataAttr="manager-sheet-stays-tab-select"
                    />
                    {staysPreviewLoading ? <p className="text-sm text-muted">Reading…</p> : null}
                    {staysPreview && !staysPreviewLoading ? (
                      <div className="flex flex-col gap-1.5 text-sm">
                        <p className="text-foreground">
                          <b>{staysPreview.stayCount}</b> stays · <b>{staysPreview.houseCount}</b> houses ·{" "}
                          <b>{staysPreview.roomCount}</b> rooms
                          {staysPreview.skipped > 0 ? ` · ${staysPreview.skipped} skipped (bad date)` : ""}
                        </p>
                        {staysPreview.unmatchedHouses.length > 0 ? (
                          <p className="text-destructive">
                            Not matched to a listing:{" "}
                            {staysPreview.unmatchedHouses.map((row) => `"${row.houseRaw}" (${row.count})`).join(", ")}
                            — rename the house on the sheet to match a listing, then reopen this tab.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        disabled={!staysPreview?.readyToLink || staysLinking}
                        onClick={() => linkStaysTab(link)}
                        data-attr="manager-sheet-stays-link"
                      >
                        Link
                      </Button>
                      <Button type="button" variant="ghost" onClick={closeStaysPicker}>
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ))}

      </PortalDialog>

      <GoogleSpreadsheetPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerTargetId(null);
        }}
        onPick={addSheet}
      />
    </PortalSettingsSections>
  );
}
