"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The title of the dialog a step is drawn in. A step heading that only repeats it ("Send a form" under a
 * dialog called "Send a form") is dropped by `StepHeading`, so a one-step pop-up never says its name twice.
 */
const DialogTitleContext = createContext<string | null>(null);

export function DialogTitleProvider({ title, children }: { title: ReactNode; children: ReactNode }) {
  const text = typeof title === "string" ? title.trim() : null;
  return <DialogTitleContext.Provider value={text || null}>{children}</DialogTitleContext.Provider>;
}

/** True when `heading` is the same words as the enclosing dialog's title. */
export function useHeadingRepeatsDialogTitle(heading: string): boolean {
  const dialogTitle = useContext(DialogTitleContext);
  return dialogTitle != null && dialogTitle.toLowerCase() === heading.trim().toLowerCase();
}
