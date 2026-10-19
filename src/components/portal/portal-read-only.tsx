"use client";

import { useEffect } from "react";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { isWorkspaceReadOnly, READ_ONLY_ATTRIBUTE, READ_ONLY_MANAGED } from "@/lib/workspaces/read-only";

/** True while the active workspace is view-only (PropLane manages it for the viewer). False outside a workspace provider. */
export function usePortalReadOnly(): boolean {
  return isWorkspaceReadOnly(useWorkspaces()?.active);
}

/**
 * Stamps `data-read-only="managed"` on the root element while the active workspace is view-only. The View-as
 * read-only CSS (globals.css) keys on it as the backstop that dims upload and submit controls; the real refusal is
 * server-side. Renders nothing.
 */
export function PortalReadOnlyRoot() {
  const readOnly = usePortalReadOnly();
  useEffect(() => {
    if (!readOnly) return;
    const root = document.documentElement;
    root.setAttribute(READ_ONLY_ATTRIBUTE, READ_ONLY_MANAGED);
    return () => root.removeAttribute(READ_ONLY_ATTRIBUTE);
  }, [readOnly]);
  return null;
}
