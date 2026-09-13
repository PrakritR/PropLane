"use client";

import { createContext, type ReactNode } from "react";

/** Existing record handlers consume one selected record; selection is internal only. */
export const RecordActionContext = createContext<{
  actions: ReactNode;
  clear: () => void;
  scope: string;
} | null>(null);
export const RecordActionItemsContext = createContext(false);

export const RecordActionCloseContext = createContext<(() => void) | null>(null);
