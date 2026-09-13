"use client";
import { createContext } from "react";
/** Null outside a record list: form and permission checkboxes stay available. */
export const RowSelectionModeContext = createContext<boolean | null>(null);
