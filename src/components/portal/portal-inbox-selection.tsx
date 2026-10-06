"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { readPortalApiError } from "@/lib/portal-api-error";
import { encodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { isDemoModeActive } from "@/lib/demo/demo-session";

export function useInboxRowSelection(selectableIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const idsKey = useMemo(() => selectableIds.join(","), [selectableIds]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [idsKey]);

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (selectableIds.length === 0) return prev;
      const all = selectableIds.every((id) => prev.has(id));
      return all ? new Set() : new Set(selectableIds);
    });
  }, [selectableIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  return { selectedIds, allSelected, toggleSelected, toggleSelectAll, clearSelection };
}

/** Bulk-selection actions, styled like the Schedule tab's toolbar: no bordered
 *  container or count label — just the buttons, left-justified. */
export function PortalInboxSelectionToolbar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {children}
      <Button type="button" variant="outline" className={PORTAL_HEADER_ACTION_BTN} onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

export async function sendManualScheduledMessageNow(id: string, opts?: { asResident?: boolean }): Promise<void> {
  const query = opts?.asResident ? "?as=resident" : "";
  const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(id)}/send-now${query}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readPortalApiError(res, "Could not send message."));
  }
}

export async function sendAutomationScheduledMessageNow(id: string): Promise<void> {
  const pathId = encodeScheduledMessagePathId(id);
  const res = await fetch(`/api/portal/scheduled-messages/${pathId}/send-now`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readPortalApiError(res, "Could not send reminder."));
  }
}

/** A send cannot be faked locally the way a cancel or an edit can, so the sandbox refuses out loud. */
export const DEMO_SEND_NOW_MESSAGE = "Not available in the demo.";

/** Send-now for either kind of scheduled message; throws (so the pop-up shows why) instead of going quiet. */
export async function sendScheduledItemNow(item: { id: string; source: "manual" | "automation" }): Promise<void> {
  if (isDemoModeActive()) throw new Error(DEMO_SEND_NOW_MESSAGE);
  if (item.source === "manual") await sendManualScheduledMessageNow(item.id);
  else await sendAutomationScheduledMessageNow(item.id);
}
