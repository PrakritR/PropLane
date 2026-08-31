"use client";

import { useMemo } from "react";
import type { PortalDefinition } from "@/lib/portal-types";

const EMPTY_RESTRICTED: ReadonlySet<string> = new Set();

/**
 * Manager portal nav is identical for every manager account. Co-manager module
 * and property grants are enforced in list APIs and row filters — not by hiding
 * or locking sidebar tabs.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature kept for call sites
export function useCoManagerNavSections(definition: PortalDefinition, _userId: string | null) {
  return useMemo(
    () => ({ sections: definition.sections, restrictedSections: EMPTY_RESTRICTED }),
    [definition],
  );
}
