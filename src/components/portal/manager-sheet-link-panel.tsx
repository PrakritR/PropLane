"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Sheet, House, Building2, Palmtree } from "lucide-react";

import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
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
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { formatGoogleCalendarConnectError } from "@/lib/google-calendar/connect-errors";
import { ALL_SHEET_PROPERTIES } from "@/lib/manager-sheet-link";

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
};

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

export function ManagerSheetLinkPanel() {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const workspaceCtx = useWorkspaces();
  const workspaceList = workspaceCtx?.workspaces ?? [];
  const activeWorkspace = workspaceCtx?.active ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [channelOpen, setChannelOpen] = useState<ChannelCalendarProvider | null>(null);
  const [channelRooms, setChannelRooms] = useState<Record<ChannelCalendarProvider, number | null>>({ airbnb: null, booking_com: null, vrbo: null });
  const propertyKey = (activeWorkspace?.propertyIds ?? []).join(",");
  const loadChannels = useCallback(async () => {
    const ids = propertyKey.split(",").filter(Boolean);
    if (!ids.length) { setChannelRooms({ airbnb: 0, booking_com: 0, vrbo: 0 }); return; }
    try {
      const properties = await fetchManagerChannelBookings(ids);
      const count = (provider: ChannelCalendarProvider) => new Set(properties.flatMap((p) => p.rooms.filter((r) => r.provider === provider && r.hasImportUrl).map((r) => `${p.propertyId}:${r.roomId}`))).size;
      setChannelRooms({ airbnb: count("airbnb"), booking_com: count("booking_com"), vrbo: count("vrbo") });
    }
    catch { showToast("Could not load channel connections."); }
  }, [propertyKey, showToast]);
  useEffect(() => { void loadChannels(); }, [loadChannels]);
  const propertyOptions = (activeWorkspace?.propertyIds ?? []).map((id) => ({ id, label: activeWorkspace?.propertyLabels?.[id] ?? id }));
  const [payload, setPayload] = useState<SheetLinkResponse | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTargetId, setPickerTargetId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
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

  const addSheet = async (sheet: { id: string; name: string }) => {
    if (pickerTargetId) {
      await patchLink(pickerTargetId, { spreadsheetId: sheet.id, title: sheet.name });
      setPickerTargetId(null);
      return;
    }
    const defaultWorkspace = activeWorkspace?.id ?? workspaceList[0]?.id ?? "";
    const res = await fetch("/api/portal/sheet-link", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spreadsheetId: sheet.id,
        title: sheet.name,
        workspaceId: defaultWorkspace,
        propertyId: ALL_SHEET_PROPERTIES,
      }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string; links?: PublicSheetBinding[] } | null;
    if (!res.ok) {
      showToast(data?.error || "Could not add the spreadsheet.");
      return;
    }
    if (data?.links) setPayload((prev) => (prev ? { ...prev, links: data.links! } : prev));
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
          {googleConnected ? <DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label="Google Sheets actions" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setPickerTargetId(null); setPickerOpen(true); }}>Add spreadsheet</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
          <Button variant="ghost" disabled={!payload || sheets?.configured === false} onClick={googleConnected ? () => disconnectGoogle() : connectGoogle}>{googleConnected ? "Disconnect" : "Connect"}</Button></div>
        </PortalSettingsRow>
        {links.map((link) => <PortalSettingsRow key={link.id} label={<span className="flex items-center gap-3 pl-4"><Sheet className="h-4 w-4 text-emerald-600" />{link.title}</span>}>
          <div className="flex items-center gap-2"><span className="hidden text-xs text-muted sm:inline">Updated {formatStamp(link.lastSyncedAt)}</span><DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${link.title} actions`} /></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!link.linked || syncingId === link.id} onSelect={() => { void updateFromSheet(link.id); }}>Update now</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditingId(link.id)}>Settings</DropdownMenuItem>
          <DropdownMenuItem className="text-danger" onSelect={() => { void removeLink(link); }}>Remove</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu></div>
        </PortalSettingsRow>)}
        {([["airbnb", "Airbnb", House, "text-rose-500"], ["booking_com", "Booking.com", Building2, "text-blue-600"], ["vrbo", "Vrbo", Palmtree, "text-indigo-600"]] as const).map(([provider, name, Icon, tone]) => {
          const rooms = channelRooms[provider];
          return <PortalSettingsRow key={provider} label={<span className="flex items-center gap-3"><Icon className={`h-5 w-5 ${tone}`} />{name}</span>}>
            <div className="flex items-center gap-2"><span className="text-xs text-muted" data-attr={`settings-${provider}-status`}>{rooms ? `Connected · ${rooms} ${rooms === 1 ? "room" : "rooms"}` : ""}</span><Button variant="ghost" data-attr={`settings-${provider}-manage`} onClick={() => setChannelOpen(provider)}>{rooms ? "Manage" : "Connect"}</Button></div>
          </PortalSettingsRow>;
        })}
      </PortalSettingsGroup>
      <ChannelCalendarLinkModal open={channelOpen !== null} onClose={() => setChannelOpen(null)} initialProvider={channelOpen ?? undefined} propertyIds={activeWorkspace?.propertyIds ?? []} propertyOptions={propertyOptions} showToast={showToast} onChanged={() => { void loadChannels(); }} />
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
                disabled={!googleConnected}
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
            <PortalSettingsRow label="Auto-update">
              <PortalSettingsToggle
                checked={link.autoSync}
                onChange={(autoSync) => patchLink(link.id, { autoSync })}
                label="Auto-update"
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
                  disabled={!link.linked || !googleConnected}
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
