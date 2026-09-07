// @vitest-environment jsdom
/**
 * A field menu inside a `Modal` must stay inside the CARD the user can see.
 *
 * `Modal`'s dialog content is a full-bleed `pointer-events-none fixed inset-0`
 * wrapper with the opaque card nested inside it, and menus are portaled to that
 * wrapper on purpose — the card is `overflow-hidden` and would clip them. But the
 * wrapper is the whole viewport, so measuring containment against it contained
 * nothing: the Start time menu in "Create recurring availability block" hung below
 * the card onto the dimmed page, and on a short window the short-host fallback
 * pinned it to the bottom of the screen, detached from the field it belongs to —
 * reported as "the drop down is showing up under the box".
 *
 * `boundsRect` is the fix: coordinates stay relative to the portal host (the
 * offset parent), bounds come from the card.
 */
import { describe, expect, it } from "vitest";
import {
  computeFieldSelectMenuRectInHost,
  fieldSelectHostBottomInsetPx,
  fieldSelectMenuBoundsElement,
  FIELD_SELECT_HOST_FOOTER_ATTR,
} from "@/components/ui/field-select-menu";

function rectOf(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A full-bleed dialog wrapper (`fixed inset-0`) with a centred card inside it. */
function dialogFixture({
  viewportH,
  cardTop,
  cardHeight,
  triggerTop,
}: {
  viewportH: number;
  cardTop: number;
  cardHeight: number;
  triggerTop: number;
}) {
  const host = document.createElement("div");
  host.setAttribute("data-slot", "modal-radix-dialog");
  host.getBoundingClientRect = () => rectOf(0, 0, 1280, viewportH);

  const card = document.createElement("div");
  card.className = "modal-panel";
  card.getBoundingClientRect = () => rectOf(cardTop, 400, 480, cardHeight);
  host.appendChild(card);

  const button = document.createElement("button");
  button.getBoundingClientRect = () => rectOf(triggerTop, 420, 223, 44);
  card.appendChild(button);

  return { host, card, button };
}

const CONTENT_PX = 259;

describe("field menu inside a full-bleed dialog wrapper", () => {
  it("resolves the visible card as the bounds, not the viewport-sized host", () => {
    const { host, card, button } = dialogFixture({
      viewportH: 600,
      cardTop: 50,
      cardHeight: 500,
      triggerTop: 307,
    });
    expect(fieldSelectMenuBoundsElement(button, host)).toBe(card);
  });

  it("keeps the menu inside the card instead of spilling onto the dimmed page", () => {
    const { host, card, button } = dialogFixture({
      viewportH: 600,
      cardTop: 50,
      cardHeight: 500,
      triggerTop: 307,
    });

    const rect = computeFieldSelectMenuRectInHost(button, CONTENT_PX, host, {
      preferOpenDown: true,
      matchTriggerWidth: true,
      strictHostContainment: true,
      bottomBoundPx: 588,
      boundsRect: card.getBoundingClientRect(),
    });

    // `top` is relative to the host, whose top is the viewport top here.
    expect(rect.position).toBe("absolute");
    expect(rect.top).toBe(307 + 44 + 4); // 4px under the trigger
    expect(rect.top + rect.maxHeight).toBeLessThanOrEqual(550); // card bottom
  });

  it("without bounds it escapes the card — the regression this guards", () => {
    const { host, card, button } = dialogFixture({
      viewportH: 600,
      cardTop: 50,
      cardHeight: 500,
      triggerTop: 307,
    });

    const rect = computeFieldSelectMenuRectInHost(button, CONTENT_PX, host, {
      preferOpenDown: true,
      matchTriggerWidth: true,
      strictHostContainment: true,
      bottomBoundPx: 588,
    });

    expect(rect.top + rect.maxHeight).toBeGreaterThan(card.getBoundingClientRect().bottom);
  });

  it("opens UP against the trigger when the card has no room below it", () => {
    // Trigger sits near the card's bottom edge: opening down leaves under a row.
    const { host, card, button } = dialogFixture({
      viewportH: 900,
      cardTop: 200,
      cardHeight: 500,
      triggerTop: 640,
    });

    const rect = computeFieldSelectMenuRectInHost(button, CONTENT_PX, host, {
      preferOpenDown: true,
      matchTriggerWidth: true,
      strictHostContainment: true,
      bottomBoundPx: 888,
      boundsRect: card.getBoundingClientRect(),
    });

    // Above the trigger, not pinned to the card's bottom edge on top of it.
    expect(rect.top + rect.maxHeight).toBeLessThanOrEqual(640);
    expect(rect.top).toBeGreaterThanOrEqual(200);
  });

  it("leaves a host that IS the visible box alone (bottom sheets, filter panels)", () => {
    const sheet = document.createElement("div");
    sheet.setAttribute("data-slot", "vaul-bottom-sheet");
    sheet.getBoundingClientRect = () => rectOf(300, 0, 400, 500);
    const button = document.createElement("button");
    button.getBoundingClientRect = () => rectOf(360, 20, 360, 44);
    sheet.appendChild(button);

    expect(fieldSelectMenuBoundsElement(button, sheet)).toBe(sheet);
  });

  it("sizes the menu above a sticky modal footer instead of behind it", () => {
    const host = document.createElement("div");
    host.setAttribute("data-slot", "modal-radix-dialog");
    host.className = "modal-panel";
    host.getBoundingClientRect = () => rectOf(80, 400, 480, 520);

    const button = document.createElement("button");
    button.getBoundingClientRect = () => rectOf(420, 420, 223, 44);
    host.appendChild(button);

    const footer = document.createElement("div");
    footer.setAttribute(FIELD_SELECT_HOST_FOOTER_ATTR, "");
    footer.getBoundingClientRect = () => rectOf(540, 400, 480, 60);
    host.appendChild(footer);

    const footerInset = fieldSelectHostBottomInsetPx(host);
    expect(footerInset).toBe(60);

    const rect = computeFieldSelectMenuRectInHost(button, CONTENT_PX, host, {
      preferOpenDown: true,
      matchTriggerWidth: true,
      strictHostContainment: true,
      bottomInsetPx: footerInset,
    });

    expect(rect.top + rect.maxHeight).toBeLessThanOrEqual(540);
  });
});
