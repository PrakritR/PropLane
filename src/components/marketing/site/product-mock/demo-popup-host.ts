"use client";

import { createContext } from "react";

/**
 * The element inside the demo window that the panels' pop-ups render into (the window draws one; absent,
 * a pop-up draws in place). Kept in its own tiny module so the window can provide it without pulling the
 * pop-up shell (`demo-popup.tsx`, which loads on demand) into the home page's first load.
 */
export const DemoPopupHostContext = createContext<HTMLElement | null>(null);
