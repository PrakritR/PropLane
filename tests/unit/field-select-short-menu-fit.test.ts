/**
 * A short option list is NOT on its own a licence to drop the height cap.
 *
 * `FieldSingleSelect` sizes a ≤5-option menu with no search row to its real content and
 * removes `maxHeight` so no inner scrollbar appears. That was decided from the option count
 * alone, before the placement was measured — so the Finance filter's four-option "Show"
 * dropdown, whose trigger sits near y≈780 on a 1440x900 window, opened downward into ~90px of
 * room and painted its last rows past the bottom of the viewport.
 *
 * The content may keep its natural height only when the MEASURED available height holds it;
 * otherwise the menu caps and scrolls. Downward placement is unchanged either way.
 */
import { describe, expect, it } from "vitest";
import {
  FIELD_SELECT_MENU_VISIBLE_ITEMS,
  fieldSelectMenuContentPx,
  fieldSelectMenuFitsWithoutScroll,
} from "@/components/ui/field-select-menu";

describe("short field-select menus", () => {
  it("fits without scroll when the measured space holds the whole list", () => {
    const content = fieldSelectMenuContentPx(4);
    expect(fieldSelectMenuFitsWithoutScroll(4, 0, content)).toBe(true);
    expect(fieldSelectMenuFitsWithoutScroll(4, 0, content + 200)).toBe(true);
  });

  it("caps and scrolls a short list the measured space cannot hold", () => {
    const content = fieldSelectMenuContentPx(4);
    // The Finance filter "Show" case: four options, ~90px of room below the trigger.
    expect(content).toBeGreaterThan(90);
    expect(fieldSelectMenuFitsWithoutScroll(4, 0, 90)).toBe(false);
    expect(fieldSelectMenuFitsWithoutScroll(4, 0, content - 2)).toBe(false);
    // A sub-pixel shortfall from a float rect keeps the natural height.
    expect(fieldSelectMenuFitsWithoutScroll(4, 0, content - 0.4)).toBe(true);
    expect(fieldSelectMenuFitsWithoutScroll(1, 0, 0)).toBe(false);
  });

  it("keeps the count and search-row rules it already had", () => {
    const roomy = 10_000;
    expect(fieldSelectMenuFitsWithoutScroll(FIELD_SELECT_MENU_VISIBLE_ITEMS, 0, roomy)).toBe(true);
    expect(fieldSelectMenuFitsWithoutScroll(FIELD_SELECT_MENU_VISIBLE_ITEMS + 1, 0, roomy)).toBe(false);
    expect(fieldSelectMenuFitsWithoutScroll(3, 52, roomy)).toBe(false);
  });

  it("answers from the count alone before the rect has been measured", () => {
    expect(fieldSelectMenuFitsWithoutScroll(3)).toBe(true);
    expect(fieldSelectMenuFitsWithoutScroll(3, 0, undefined)).toBe(true);
  });
});
