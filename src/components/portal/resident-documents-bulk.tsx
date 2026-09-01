"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

export function residentDocumentsOpenAction(
  label: string,
  onOpen: () => void,
  dataAttr: string,
): PortalAdaptiveAction {
  return {
    id: "open",
    keepPriority: 10,
    alwaysVisible: true,
    node: (
      <Button
        type="button"
        variant="primary"
        className={PORTAL_BULK_BAR_BTN}
        data-attr={dataAttr}
        onClick={onOpen}
      >
        {label}
      </Button>
    ),
    menuItem: (
      <DropdownMenuItem data-attr={dataAttr} onSelect={onOpen}>
        {label}
      </DropdownMenuItem>
    ),
  };
}

export function residentDocumentsDownloadAction(
  label: string,
  onDownload: () => void,
  dataAttr: string,
  disabled?: boolean,
): PortalAdaptiveAction {
  return {
    id: "download",
    keepPriority: 5,
    node: (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr={dataAttr}
        disabled={disabled}
        onClick={onDownload}
      >
        {label}
      </Button>
    ),
    menuItem: (
      <DropdownMenuItem data-attr={dataAttr} disabled={disabled} onSelect={onDownload}>
        {label}
      </DropdownMenuItem>
    ),
  };
}

export function residentDocumentsRemoveAction(
  onRemove: () => void,
  dataAttr: string,
): PortalAdaptiveAction {
  return {
    id: "remove",
    keepPriority: 3,
    node: (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr={dataAttr}
        onClick={onRemove}
      >
        Remove
      </Button>
    ),
    menuItem: (
      <DropdownMenuItem data-attr={dataAttr} onSelect={onRemove}>
        Remove
      </DropdownMenuItem>
    ),
  };
}

export function useResidentDocumentSelection(rowIds: readonly string[]) {
  const rowIdsKey = rowIds.join(",");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedIds(new Set());
  }, [rowIdsKey]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  return { selectedIds, toggleSelected, clearSelection };
}
