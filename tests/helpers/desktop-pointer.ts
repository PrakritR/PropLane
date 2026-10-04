import { vi } from "vitest";

/**
 * jsdom's baseline `matchMedia` matches nothing, i.e. a touch device — so a select renders as the
 * shared phone bottom sheet. A suite that asserts the desktop popover menu (or the Settings pills)
 * calls this in `beforeEach`; `vi.unstubAllGlobals()` / the next stub undoes it.
 */
export function stubDesktopPointer() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}
