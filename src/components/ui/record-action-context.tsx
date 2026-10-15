"use client";

import { createContext, type ReactNode } from "react";

/** Existing record handlers consume one selected record; selection is internal only. */
export const RecordActionContext = createContext<{
  actions: ReactNode;
  clear: () => void;
  scope: string;
  /**
   * The actions belong to a selection made when the menu OPENS (a list surface's shared bulk actions),
   * so they are unknown at render time and a lone item cannot become an icon. A row that supplies its
   * own actions up front leaves this off.
   */
  lazy?: boolean;
} | null>(null);
export const RecordActionItemsContext = createContext(false);

export const RecordActionCloseContext = createContext<(() => void) | null>(null);
