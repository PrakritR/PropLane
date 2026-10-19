"use client";

import { createContext, useContext } from "react";

/**
 * Whether the active workspace is view-only (PropLane manages it for the viewer). A leaf context with no imports of its
 * own on purpose: PortalIconAction, PortalPrimaryIconAction and the dropdown menu read it, and none of them may pull the
 * workspace provider (and everything it imports) into their module graph. `PortalReadOnlyProvider` writes it.
 * Outside a provider (resident, vendor, admin, /demo) it is false.
 */
export const PortalReadOnlyContext = createContext(false);

export function usePortalReadOnly(): boolean {
  return useContext(PortalReadOnlyContext);
}
