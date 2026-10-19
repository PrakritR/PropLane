"use client";

import { useEffect, type ReactNode } from "react";
import { PortalReadOnlyContext } from "@/components/portal/portal-read-only-context";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { isWorkspaceReadOnly, READ_ONLY_ATTRIBUTE, READ_ONLY_MANAGED } from "@/lib/workspaces/read-only";

export { usePortalReadOnly } from "@/components/portal/portal-read-only-context";

/**
 * Provides "the active workspace is view-only" to every create / edit control below it, and stamps
 * `data-read-only="managed"` on the root element while it is. The View-as read-only CSS (globals.css) keys on that stamp
 * as the backstop that dims upload and submit controls; the real refusal is server-side. Mount it inside WorkspaceProvider.
 */
export function PortalReadOnlyProvider({ children }: { children: ReactNode }) {
  const readOnly = isWorkspaceReadOnly(useWorkspaces()?.active);
  useEffect(() => {
    if (!readOnly) return;
    const root = document.documentElement;
    root.setAttribute(READ_ONLY_ATTRIBUTE, READ_ONLY_MANAGED);
    return () => root.removeAttribute(READ_ONLY_ATTRIBUTE);
  }, [readOnly]);
  return <PortalReadOnlyContext.Provider value={readOnly}>{children}</PortalReadOnlyContext.Provider>;
}
