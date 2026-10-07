"use client";

/**
 * The demo window's animated cursor (captain 2026-10-07, round 7): a pointer arrow with a small
 * role label ("Manager") that glides to a control, hovers it, presses with a ripple, and lets the
 * real UI respond. It lives in an overlay inside the window, so it can never cover the phone, and
 * it draws nothing under `prefers-reduced-motion` (the engine does not mount it then).
 *
 * Everything here is imperative on purpose: the engine awaits each move, so a step is "go there,
 * hover, press, click" in a few lines. Targets are found by `data-demo-target="<id>"`; a wrapper
 * that draws no box (`display: contents`) resolves to the button inside it.
 */

import { useCallback, useImperativeHandle, useRef, type Ref } from "react";

export type DemoCursorApi = {
  /** Resolve a target, waiting for it to render; `null` when it never does. */
  find(id: string, timeoutMs?: number): Promise<HTMLElement | null>;
  /** Scroll the target into view inside its own scroll areas (never the page) and glide the cursor to it. */
  moveTo(el: HTMLElement): Promise<void>;
  /** Press: the arrow dips and a ripple rings out. */
  press(): Promise<void>;
  /** Drop the hover state a move left on its target. */
  clearHover(): void;
  /** Fade the cursor out until the next move. */
  hide(): void;
};

export const MOVE_MS = 850;
export const HOVER_MS = 320;
export const PRESS_MS = 170;
export const SETTLE_MS = 480;

export const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** The element the cursor should aim at: a `display: contents` wrapper hands over to its button. */
function aimAt(el: HTMLElement): HTMLElement {
  if (getComputedStyle(el).display !== "contents") return el;
  // A list row's own button carries `data-attr="…-list-row"`; its ⋯ menu and checkbox are not the target.
  return (
    el.querySelector<HTMLElement>("button[data-attr$='-list-row']") ??
    el.querySelector<HTMLElement>("button, a, [role='button']") ??
    (el.firstElementChild as HTMLElement | null) ??
    el
  );
}

/** Scroll every scrollable ancestor (up to `boundary`) just enough to put `el` in view. */
async function revealWithin(el: HTMLElement, boundary: HTMLElement) {
  let moved = false;
  for (let node = el.parentElement; node && node !== boundary.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const scrollsY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const scrollsX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (!scrollsY && !scrollsX) continue;
    const box = node.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const margin = 28;
    // The window's bottom edge fades out over ~64px: a target never rests under it.
    const bottomMargin = 76;
    let top = node.scrollTop;
    let left = node.scrollLeft;
    if (scrollsY && (rect.top < box.top + margin || rect.bottom > box.bottom - bottomMargin)) {
      top += rect.top - box.top - (box.height - rect.height) / 2;
    }
    if (scrollsX && (rect.left < box.left + margin || rect.right > box.right - margin)) {
      left += rect.left - box.left - (box.width - rect.width) / 2;
    }
    if (Math.abs(top - node.scrollTop) > 1 || Math.abs(left - node.scrollLeft) > 1) {
      node.scrollTo({ top, left, behavior: "smooth" });
      moved = true;
    }
  }
  if (moved) await sleep(520);
}

export function DemoCursor({ label, apiRef }: { label: string; apiRef: Ref<DemoCursorApi> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  const find = useCallback(async (id: string, timeoutMs = 2400) => {
    const layer = layerRef.current;
    const scope = layer?.parentElement;
    if (!scope) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = scope.querySelector<HTMLElement>(`[data-demo-target="${id}"]`);
      if (hit) return aimAt(hit);
      if (Date.now() > deadline) return null;
      await sleep(80);
    }
  }, []);

  useImperativeHandle(
    apiRef,
    () => ({
      find,
      async moveTo(el) {
        const layer = layerRef.current;
        const cursor = cursorRef.current;
        if (!layer || !cursor) return;
        await revealWithin(el, layer.parentElement ?? layer);
        const box = layer.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        // The hero window grows with a transform, so measure in the window's own units.
        const scale = layer.offsetWidth ? box.width / layer.offsetWidth : 1;
        const x = (rect.left + Math.min(rect.width / 2, 140) - box.left) / scale;
        const y = (rect.top + Math.min(rect.height / 2, 24) - box.top) / scale;
        if (!placed.current) {
          // First appearance: start from the lower right of the window and glide in.
          placed.current = true;
          cursor.style.transition = "none";
          cursor.style.transform = `translate(${layer.offsetWidth * 0.78}px, ${layer.offsetHeight * 0.82}px)`;
          void cursor.offsetWidth;
          cursor.style.transition = "";
        }
        // Near the window's right or bottom edge the role label flips to the other side of the arrow.
        cursor.dataset.flipX = String(x > layer.offsetWidth - 120);
        cursor.dataset.flipY = String(y > layer.offsetHeight - 44);
        cursor.dataset.visible = "true";
        cursor.style.transform = `translate(${x}px, ${y}px)`;
        if (rippleRef.current) {
          rippleRef.current.style.left = `${x}px`;
          rippleRef.current.style.top = `${y}px`;
        }
        await sleep(MOVE_MS);
        el.setAttribute("data-demo-hover", "");
        await sleep(HOVER_MS);
      },
      async press() {
        const cursor = cursorRef.current;
        const ripple = rippleRef.current;
        if (!cursor) return;
        cursor.dataset.pressing = "true";
        if (ripple) {
          ripple.classList.remove("rlp-cursor-ripple-go");
          void ripple.offsetWidth;
          ripple.classList.add("rlp-cursor-ripple-go");
        }
        await sleep(PRESS_MS);
        cursor.dataset.pressing = "false";
      },
      clearHover() {
        layerRef.current?.parentElement?.querySelectorAll("[data-demo-hover]").forEach((node) => node.removeAttribute("data-demo-hover"));
      },
      hide() {
        const cursor = cursorRef.current;
        if (cursor) cursor.dataset.visible = "false";
        this.clearHover();
      },
    }),
    [find],
  );

  return (
    <div className="rlp-cursor-layer" ref={layerRef} aria-hidden>
      <span className="rlp-cursor-ripple" ref={rippleRef} />
      <div className="rlp-cursor" ref={cursorRef} data-visible="false" data-pressing="false">
        <svg viewBox="0 0 24 28" width="22" height="26" focusable="false">
          <path
            d="M3 2.2v19.4l5.1-4.6 3.4 7.6 3.3-1.5-3.4-7.4 7.1-.5z"
            fill="#0f1b2d"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rlp-cursor-label">{label}</span>
      </div>
    </div>
  );
}
