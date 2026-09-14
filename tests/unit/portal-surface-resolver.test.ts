import { describe, expect, it } from "vitest";
import {
  portalSurfaceWidthPx,
  resolvePortalSurface,
  type PortalSurfaceKind,
} from "@/components/ui/portal-surface";

/**
 * The whole decision used to be `(max-width: 1023px)` → bottom sheet, so a
 * browser window narrower than 1024px handed a desktop user a phone sheet,
 * grabber handle included. That is what every one of the captain's 2026-09-13
 * screenshots is, and it is the case pinned first below.
 */
const mouse = { finePointer: true, noRoomForPopover: false };
/**
 * The exact browser state behind the screenshots, measured on the running app:
 * `innerWidth: 900`, `(pointer: fine)` true, `(max-width: 1023px)` ALSO true.
 *
 * This case is the whole point of the file. A first version of this resolver
 * broke the tie with the 1023px breakpoint and therefore still returned a sheet
 * here — reproducing the reported bug while the suite stayed green, because the
 * test pinned `smallViewport: false`, which is not what a 900px window reports.
 */
const macAt900px = { finePointer: true, noRoomForPopover: false };
const phoneWidth = { finePointer: false, noRoomForPopover: true };
const touch = { finePointer: false, noRoomForPopover: false };

describe("a mouse in a narrow window is still a mouse", () => {
  it("keeps the popover at 900px on a Mac — the reported bug", () => {
    expect(resolvePortalSurface("toolbar", macAt900px)).toBe("popover");
  });

  it("only falls back to a sheet when a popover genuinely will not fit", () => {
    expect(resolvePortalSurface("toolbar", { finePointer: true, noRoomForPopover: true })).toBe("sheet");
  });

  it("gives a phone a sheet", () => {
    expect(resolvePortalSurface("toolbar", phoneWidth)).toBe("sheet");
  });
});

describe("what it is decides the shape", () => {
  it("gives a toolbar control a popover and a form a dialog, on a mouse", () => {
    expect(resolvePortalSurface("toolbar", mouse)).toBe("popover");
    expect(resolvePortalSurface("short-form", mouse)).toBe("dialog");
    expect(resolvePortalSurface("long-form", mouse)).toBe("dialog");
    expect(resolvePortalSurface("settings", mouse)).toBe("dialog");
  });

  it("gives everything a sheet on touch", () => {
    for (const kind of ["toolbar", "short-form", "long-form", "settings"] as PortalSurfaceKind[]) {
      expect(resolvePortalSurface(kind, touch)).toBe("sheet");
    }
  });
});

describe("a destructive question is never a sheet", () => {
  it("stays a dialog on every device", () => {
    // A sheet can be swiped away; a question you must actually answer should
    // interrupt rather than be dismissible by accident.
    expect(resolvePortalSurface("confirm", mouse)).toBe("dialog");
    expect(resolvePortalSurface("confirm", touch)).toBe("dialog");
    expect(resolvePortalSurface("confirm", phoneWidth)).toBe("dialog");
  });
});

describe("width follows the kind, so a two-field form is not given a six-field frame", () => {
  it("grows with the amount of content the kind implies", () => {
    expect(portalSurfaceWidthPx("toolbar")).toBeLessThan(portalSurfaceWidthPx("short-form"));
    expect(portalSurfaceWidthPx("short-form")).toBeLessThan(portalSurfaceWidthPx("settings"));
    expect(portalSurfaceWidthPx("settings")).toBeLessThan(portalSurfaceWidthPx("long-form"));
  });

  it("answers for every kind", () => {
    for (const kind of ["toolbar", "short-form", "long-form", "settings", "confirm"] as PortalSurfaceKind[]) {
      expect(portalSurfaceWidthPx(kind)).toBeGreaterThan(0);
    }
  });
});
