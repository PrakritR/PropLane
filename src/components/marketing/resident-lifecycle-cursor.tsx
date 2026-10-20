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

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type DemoCursorApi = {
  /** Resolve a target, waiting for it to render; `null` when it never does. */
  find(id: string, timeoutMs?: number): Promise<HTMLElement | null>;
  /**
   * Scroll the target into view inside its own scroll areas (never the page) and glide the cursor onto it, re-measuring
   * the real element until the arrow rests on it. `resolve` finds the control again when a re-render replaced it
   * mid-glide; the element the cursor ended on is returned (the one to click).
   */
  moveTo(el: HTMLElement, resolve?: () => HTMLElement | null): Promise<HTMLElement>;
  /** Press: the arrow re-aims if the control moved, then dips and a ripple rings out. */
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
/** How long a freshly found target must stay in place before the cursor aims at it. */
const SETTLE_FIND_MS = 220;

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

/** The arrow's tip inside its 22x26 svg: the point that lands on the control. */
const TIP_X = 3;
const TIP_Y = 2.2;
/** How far (px) the arrow may sit from its aim point and still count as there. */
const ON_TARGET_PX = 2;
/** The longest the cursor keeps following a control that is still moving before it presses anyway. */
const FOLLOW_MAX_MS = 1200;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The box of the control's own label: its first run of visible text. */
function labelRect(el: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}

/**
 * Where the tip rests, in viewport pixels: the middle of the control's label (a wide sidebar row's word, not the empty
 * space beside it), or the control's centre when it has no text, always inside the control's own box.
 */
function aimPoint(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const label = labelRect(el);
  const onLabel = label && label.left >= rect.left - 1 && label.right <= rect.right + 1 && label.top >= rect.top - 1 && label.bottom <= rect.bottom + 1;
  const x = onLabel ? label.left + label.width / 2 : rect.left + rect.width / 2;
  const y = onLabel ? label.top + label.height / 2 : rect.top + rect.height / 2;
  const inset = (size: number) => Math.min(4, size / 2);
  return {
    x: clamp(x, rect.left + inset(rect.width), rect.right - inset(rect.width)),
    y: clamp(y, rect.top + inset(rect.height), rect.bottom - inset(rect.height)),
  };
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

  /** The control the cursor is on (or heading to), and how to find it again if a re-render replaces it. */
  const targetRef = useRef<{ el: HTMLElement; resolve?: () => HTMLElement | null } | null>(null);

  /** The live element for the current target: the same node while it is on the page, else a fresh lookup. */
  const currentTarget = useCallback((): HTMLElement | null => {
    const target = targetRef.current;
    if (!target) return null;
    if (target.el.isConnected) return target.el;
    const fresh = target.resolve?.() ?? null;
    if (fresh) target.el = aimAt(fresh);
    return fresh ? target.el : null;
  }, []);

  /** The window-local translate that puts the arrow's tip on `el`, measured from the real boxes right now. */
  const placement = useCallback((el: HTMLElement) => {
    const layer = layerRef.current!;
    const box = layer.getBoundingClientRect();
    // The hero window grows with a transform, so measure in the window's own units.
    const scale = layer.offsetWidth ? box.width / layer.offsetWidth : 1;
    const point = aimPoint(el);
    return { x: (point.x - box.left) / scale - TIP_X, y: (point.y - box.top) / scale - TIP_Y };
  }, []);

  /** Send the arrow toward `el` (an in-flight glide bends toward the new point). */
  const aim = useCallback((el: HTMLElement, instant = false) => {
    const layer = layerRef.current;
    const cursor = cursorRef.current;
    if (!layer || !cursor) return;
    const { x, y } = placement(el);
    if (instant) cursor.style.transition = "none";
    // Near the window's right or bottom edge the role label flips to the other side of the arrow.
    cursor.dataset.flipX = String(x > layer.offsetWidth - 120);
    cursor.dataset.flipY = String(y > layer.offsetHeight - 44);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    if (rippleRef.current) {
      rippleRef.current.style.left = `${x + TIP_X}px`;
      rippleRef.current.style.top = `${y + TIP_Y}px`;
    }
    if (instant) {
      void cursor.offsetWidth;
      cursor.style.transition = "";
    }
  }, [placement]);

  /** Where the arrow is drawn now (mid-transition included), in the same window-local units as `placement`. */
  const drawnAt = useCallback(() => {
    const layer = layerRef.current!;
    const cursor = cursorRef.current!;
    const box = layer.getBoundingClientRect();
    const rect = cursor.getBoundingClientRect();
    const scale = layer.offsetWidth ? box.width / layer.offsetWidth : 1;
    return { x: (rect.left - box.left) / scale, y: (rect.top - box.top) / scale };
  }, []);

  /**
   * Keep aiming at the current target until the drawn arrow sits on it: re-measured every frame, re-found when it was
   * replaced, bounded so a control that never stops moving cannot stall the journey. Resolves the element it is on.
   */
  const settleOn = useCallback(async (): Promise<HTMLElement> => {
    const start = Date.now();
    let el = currentTarget() ?? targetRef.current!.el;
    for (;;) {
      el = currentTarget() ?? el;
      const want = placement(el);
      const have = drawnAt();
      if (Math.abs(want.x - have.x) <= ON_TARGET_PX && Math.abs(want.y - have.y) <= ON_TARGET_PX) return el;
      if (Date.now() - start > FOLLOW_MAX_MS) {
        aim(el, true);
        return el;
      }
      aim(el);
      await sleep(60);
    }
  }, [aim, currentTarget, drawnAt, placement]);

  // A resize (the window rescales with the page) moves every control: put the arrow back on the one it is on.
  useEffect(() => {
    const onResize = () => {
      const el = currentTarget();
      if (el && cursorRef.current?.dataset.visible === "true") aim(el, true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [aim, currentTarget]);

  const find = useCallback(async (id: string, timeoutMs = 2400) => {
    const layer = layerRef.current;
    const scope = layer?.parentElement;
    if (!scope) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = scope.querySelector<HTMLElement>(`[data-demo-target="${id}"]`);
      if (hit) {
        // A page that has just mounted may swap its toolbar for a fresh copy once it has measured itself
        // (the real portal's list stack does): take the copy that is still there a beat later.
        await sleep(SETTLE_FIND_MS);
        return aimAt(scope.querySelector<HTMLElement>(`[data-demo-target="${id}"]`) ?? hit);
      }
      if (Date.now() > deadline) return null;
      await sleep(80);
    }
  }, []);

  useImperativeHandle(
    apiRef,
    () => ({
      find,
      async moveTo(el, resolve) {
        const layer = layerRef.current;
        const cursor = cursorRef.current;
        if (!layer || !cursor) return el;
        await revealWithin(el, layer.parentElement ?? layer);
        if (!placed.current) {
          // First appearance: start from the lower right of the window and glide in.
          placed.current = true;
          cursor.style.transition = "none";
          cursor.style.transform = `translate(${layer.offsetWidth * 0.78}px, ${layer.offsetHeight * 0.82}px)`;
          void cursor.offsetWidth;
          cursor.style.transition = "";
        }
        cursor.dataset.visible = "true";
        targetRef.current = { el, resolve };
        aim(el);
        await sleep(MOVE_MS);
        // The glide was aimed at where the control was when it started. Follow the real element (a tab strip that
        // re-measured, a list that re-rendered, a resize) until the arrow is resting on it.
        const landed = await settleOn();
        landed.setAttribute("data-demo-hover", "");
        await sleep(HOVER_MS);
        return settleOn();
      },
      async press() {
        const cursor = cursorRef.current;
        const ripple = rippleRef.current;
        if (!cursor) return;
        if (targetRef.current) await settleOn();
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
        targetRef.current = null;
        if (cursor) cursor.dataset.visible = "false";
        this.clearHover();
      },
    }),
    [aim, find, settleOn],
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
