"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { GoogleSpreadsheetPicker } from "@/components/portal/google-spreadsheet-picker";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListAddRow } from "@/components/portal/portal-list-add-row";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
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
  const [payload, setPayload] = useState<SheetLinkResponse | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTargetId, setPickerTargetId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

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
    if (gsheet === "error") showToast(params.get("reason") || "Google Sheets connect failed.");
    params.delete("gsheet");
    params.delete("reason");
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
    void load();
  }, [load, showToast]);

  const connectGoogle = () => {
    const origin = encodeURIComponent(window.location.origin);
    const returnTo = encodeURIComponent("/portal/profile?tab=spreadsheets");
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

  const links = payload?.links ?? [];
  const sheets = payload?.sheets;
  const googleConnected = Boolean(sheets?.connected);

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Google">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Google">
            {googleConnected ? (
              <Button type="button" variant="ghost" onClick={() => disconnectGoogle()}>
                {sheets?.email || "Connected"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={sheets?.configured === false}
                onClick={connectGoogle}
              >
                Connect
              </Button>
            )}
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {links.map((link) => (
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
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ))}

      <PortalListAddRow
        label="Add spreadsheet"
        ariaLabel="Add spreadsheet"
        inline={links.length > 0}
        disabled={!googleConnected}
        onClick={() => {
          setPickerTargetId(null);
          setPickerOpen(true);
        }}
        dataAttr="manager-sheet-add"
      />

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
