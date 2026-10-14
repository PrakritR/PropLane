"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";
import { FIELD_SELECT_MENU_Z_INDEX } from "@/components/ui/field-select-menu";
import { SHEET_MS, MOTION_EASE, sheetEasing } from "@/components/ui/motion/tokens";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";
import { usePortalSurface } from "@/components/ui/portal-surface";
import { liveOpacity, liveTranslateY, useSheetDrag } from "@/components/ui/use-sheet-drag";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";

/**
 * The ONE phone bottom sheet.
 *
 * The section pickers (settings, record sections, wizard steps) draw this surface on a phone.
 * Selects (FieldSingleSelect / CheckboxMultiSelect) do NOT: they open a list attached under the
 * field (ui/field-select-menu.tsx), so a field never throws a sheet from the bottom. The captain's
 * Oct 3 screenshot is the bug this replaces: the step sheet sat at `z-[90]`, UNDER the
 * dialog panel (`z-[91]`) and its footer, and its `bg-card` background resolves to a
 * translucent white under `[data-theme]` — so the popup's own rows and its disabled
 * "Continue" pill showed through the list.
 *
 * Rules this component owns, so no caller re-derives them:
 *   - opaque surface (`phone-sheet-surface`, never a bare translucent `bg-card`);
 *   - a full-screen backdrop that dims EVERYTHING, popup footer included;
 *   - stacked above the dialog stack (90/91) and the floating field menus, by the named
 *     constants below rather than a hard-coded number at the call site;
 *   - Escape, backdrop tap and a swipe down all close it; focus is trapped inside and
 *     handed back to the trigger.
 *   - it slides up from the bottom, follows the finger 1:1 with the scrim fading under it,
 *     and a release inherits the throw's velocity (settle or dismiss); it stays mounted for
 *     its exit and is interruptible at any point. Reduced motion cross-fades instead.
 */

/** Dims the page, the dialog and its footer. One above the field-select menus (10060). */
export const PHONE_SHEET_BACKDROP_Z_INDEX = FIELD_SELECT_MENU_Z_INDEX + 10;
/** The sheet itself, above its own backdrop. */
export const PHONE_SHEET_Z_INDEX = PHONE_SHEET_BACKDROP_Z_INDEX + 1;
/** Hard ceiling on the panel so a long list scrolls inside it. */
export const PHONE_SHEET_MAX_HEIGHT = "70dvh";
// Release is decided by velocity and projection, not a fixed pixel count:
// see `resolveSheetRelease` in `src/lib/ui/sheet-release.ts`.

/**
 * True when a select should render as this sheet: a touch device, or a window too narrow
 * for a popover. The same decision the dialogs make (`ui/portal-surface.ts`), so a select
 * inside a phone drawer always opens as a sheet and one on a desktop stays a popover.
 */
export function usePhoneSheetPresentation(): boolean {
  return usePortalSurface("short-form") === "sheet";
}

export function PhoneBottomSheet({
  open,
  onClose,
  title,
  meta,
  toolbar,
  footer,
  children,
  triggerRef,
  id,
  closeLabel = "Close",
  closeDataAttr,
  dataAttr,
  rootProps,
}: {
  open: boolean;
  onClose: () => void;
  /** "Steps", or the field's label for a select. */
  title: string;
  /** Right of the title, left of the close: the "N to finish" count. */
  meta?: ReactNode;
  /** Pinned under the header (a select's search row). */
  toolbar?: ReactNode;
  /** Pinned under the list (a select's menu footer). */
  footer?: ReactNode;
  children: ReactNode;
  /** Focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  id?: string;
  closeLabel?: string;
  closeDataAttr?: string;
  dataAttr?: string;
  /** Extra data-* markers on the sheet root (a caller's own test / dismiss-guard hook). */
  rootProps?: Record<string, string>;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const exitingRef = useRef(false);
  const reducedMotion = useReducedMotion();
  // Stay mounted through the exit animation; `open` alone no longer decides presence.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  const drag = useSheetDrag({
    getPanel: useCallback(() => panelRef.current, []),
    getScrim: useCallback(() => backdropRef.current, []),
    onDismiss: () => onCloseRef.current(),
    reducedMotion,
  });

  // Entrance: rise from the bottom (or fade under reduced motion). If the sheet is still
  // leaving, reverse from where it is on screen instead of restarting.
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel || !backdrop || typeof panel.animate !== "function") return;
    const resumed = exitingRef.current;
    const fromY = resumed ? liveTranslateY(panel) : panel.offsetHeight;
    const fromOpacity = resumed ? liveOpacity(backdrop) : 0;
    exitingRef.current = false;
    panel.getAnimations().forEach((a) => a.cancel());
    backdrop.getAnimations().forEach((a) => a.cancel());
    const easing = sheetEasing();
    if (reducedMotion) {
      panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SHEET_MS.fade, easing: "ease-out" });
    } else {
      panel.animate(
        [{ transform: `translateY(${fromY}px)` }, { transform: "translateY(0px)" }],
        { duration: SHEET_MS.enter, easing },
      );
    }
    backdrop.animate([{ opacity: fromOpacity }, { opacity: 1 }], { duration: SHEET_MS.fade, easing: "ease-out" });
    // Only `open` should start an entrance; a reduced-motion flip mid-flight must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  // Exit: continue from the live offset (a throw keeps its momentum), then unmount.
  useLayoutEffect(() => {
    if (open || !mounted) return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel || !backdrop || typeof panel.animate !== "function") {
      setMounted(false);
      return;
    }
    exitingRef.current = true;
    const fromY = liveTranslateY(panel);
    const fromOpacity = liveOpacity(backdrop);
    panel.style.transform = "";
    backdrop.style.opacity = "";
    const exit = reducedMotion
      ? panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHEET_MS.fade, easing: "ease-out", fill: "forwards" })
      : panel.animate(
          [{ transform: `translateY(${fromY}px)` }, { transform: "translateY(100%)" }],
          { duration: SHEET_MS.exit, easing: MOTION_EASE.out, fill: "forwards" },
        );
    backdrop.animate([{ opacity: fromOpacity }, { opacity: 0 }], {
      duration: reducedMotion ? SHEET_MS.fade : SHEET_MS.exit,
      easing: "ease-out",
      fill: "forwards",
    });
    exit.finished
      .then(() => {
        if (!exitingRef.current) return;
        exitingRef.current = false;
        setMounted(false);
      })
      .catch(() => {
        // Cancelled by a re-open: the entrance effect owns the sheet again.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useFocusTrap(open, panelRef);

  // Focus goes back to the control that opened the sheet, not to <body>.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef?.current ?? null;
    return () => {
      trigger?.focus?.();
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    // Window + capture: runs before Radix's own document-level Escape/focus handling, so
    // closing the sheet never also closes the dialog underneath it, and focusing a sheet row
    // is not read as focus leaving that dialog (which would snap focus back out).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open]);

  if (!mounted || typeof document === "undefined") return null;

  const sheet = (
    <div
      id={id}
      // Same marker as the floating field menus: modal outside-click guards leave it alone.
      {...{ [FIELD_SELECT_MENU_DATA_ATTR]: "" }}
      data-phone-bottom-sheet=""
      data-attr={dataAttr}
      {...rootProps}
      className="pointer-events-auto fixed inset-0 flex items-end justify-center"
      // The ROOT owns the layer: without it the sheet paints in document order and a popup
      // (z-[80]) covers it, so the children's z-indexes only order things inside the sheet.
      style={{ zIndex: PHONE_SHEET_BACKDROP_Z_INDEX, pointerEvents: open ? undefined : "none" }}
    >
      <button
        ref={backdropRef}
        type="button"
        aria-label={`Dismiss ${title}`}
        tabIndex={-1}
        data-phone-sheet-backdrop=""
        className="phone-sheet-scrim absolute inset-0 cursor-default bg-black/50"
        style={{ zIndex: PHONE_SHEET_BACKDROP_Z_INDEX, touchAction: "none" }}
        onClick={() => onCloseRef.current()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-phone-sheet-panel=""
        className="phone-sheet-surface bg-card relative flex w-full flex-col overflow-hidden rounded-t-[20px] border-t border-border text-foreground shadow-[0_-12px_40px_-12px_rgba(11,27,58,0.4)] outline-none motion-reduce:transition-none"
        style={{
          zIndex: PHONE_SHEET_Z_INDEX,
          maxHeight: PHONE_SHEET_MAX_HEIGHT,
        }}
      >
        {/* Handle + title: the swipe-down zone. The close button opts out so it still taps. */}
        <div
          className="shrink-0 select-none"
          style={{ touchAction: "none" }}
          {...drag}
        >
          <span className="mx-auto mt-2 block h-1 w-10 rounded-full bg-border" aria-hidden />
          <div className="flex min-h-12 items-center gap-3 pl-5 pr-2">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-[17px] font-extrabold tracking-tight text-foreground">
              {title}
            </h2>
            {meta}
            <PortalIconAction label={closeLabel} icon={X} data-attr={closeDataAttr} onClick={() => onCloseRef.current()} />
          </div>
        </div>
        {toolbar}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [-webkit-overflow-scrolling:touch]"
          style={{ touchAction: "pan-y" }}
          // The dialog underneath locks scroll outside itself; these keep the list scrollable.
          onWheel={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {children}
        </div>
        {footer ? <div className="shrink-0 border-t border-border px-2 py-1.5">{footer}</div> : null}
        <div className="shrink-0 pb-[env(safe-area-inset-bottom,0px)]" aria-hidden />
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}

/** 48px tall row shell shared by button rows and link rows. */
export const PHONE_SHEET_ROW_CLASS =
  "relative flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40 disabled:opacity-45";

/** Glyph slot, label and trailing marker of a row. The label wraps instead of truncating. */
function PhoneSheetRowBody({
  current,
  glyph,
  children,
  trailing,
}: {
  current: boolean;
  glyph?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      {current ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" aria-hidden /> : null}
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        {glyph}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 break-words text-[15px] leading-snug",
          current ? "font-bold text-foreground" : "font-semibold text-foreground/85",
        )}
      >
        {children}
      </span>
      {trailing}
    </>
  );
}

/**
 * One row of the sheet. 48px tall, a leading glyph centred on the label, and the current /
 * chosen row marked by a blue bar on its left edge plus bold text — never a far-right word.
 */
export function PhoneSheetRow({
  current = false,
  glyph,
  children,
  trailing,
  className,
  ...rest
}: {
  /** The step you are on, or the option that is chosen. */
  current?: boolean;
  /** Leading status glyph: check done, red dot needs attention, ring current. */
  glyph?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={current}
      data-current={current || undefined}
      className={cn(PHONE_SHEET_ROW_CLASS, className)}
      {...rest}
    >
      <PhoneSheetRowBody current={current} glyph={glyph} trailing={trailing}>
        {children}
      </PhoneSheetRowBody>
    </button>
  );
}

/** Leading glyph vocabulary shared by every picker: done check, needs-attention dot, current ring. */
export function PhoneSheetGlyph({ kind }: { kind: "done" | "attention" | "current" | "todo" | "check" | "none" }) {
  if (kind === "none") return null;
  if (kind === "attention") return <span className="size-[9px] rounded-full bg-[var(--status-overdue-fg)]" />;
  if (kind === "done" || kind === "check") return <Check className="size-4 text-primary" strokeWidth={2.5} />;
  if (kind === "current") return <span className="size-[18px] rounded-full border-2 border-primary" />;
  return <span className="size-[18px] rounded-full border border-border" />;
}

export type PhonePickerItem = {
  id: string;
  label: ReactNode;
  /** The section you are on. */
  current?: boolean;
  glyph?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  /** A routed section: the row is a real link. */
  href?: string;
  /** A stateful section: the row calls this. */
  onSelect?: () => void;
  dataAttr?: string;
  /** Screen-reader-only addition to the label ("Needs something"). */
  srHint?: string;
};
export type PhonePickerGroup = { label?: string; items: PhonePickerItem[] };

/**
 * A "jump to section" control: a trigger showing where you are, opening the shared sheet. The
 * wizard step picker, the record-page section picker and the Settings section picker are all
 * this component, so their rows, current marker, backdrop and z-order cannot drift apart.
 */
export function PhoneSectionPicker({
  title,
  groups,
  trigger,
  triggerLabel,
  triggerDataAttr,
  meta,
  sheetDataAttr,
  closeDataAttr,
  groupDataAttr,
  rootProps,
  className,
  ariaCurrent = "step",
  controlsLabel,
}: {
  title: string;
  groups: PhonePickerGroup[];
  /** The trigger's visible content (current section + chevron are added by the caller or default). */
  trigger: ReactNode;
  /** Accessible name of the trigger. Omit to let its content name it. */
  triggerLabel?: string;
  triggerDataAttr?: string;
  meta?: ReactNode;
  sheetDataAttr?: string;
  closeDataAttr?: string;
  /** Prefix for group heading data-attrs. */
  groupDataAttr?: string;
  rootProps?: Record<string, string>;
  className?: string;
  ariaCurrent?: "step" | "page";
  controlsLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const close = () => setOpen(false);
  const linkMode = groups.some((group) => group.items.some((item) => item.href));
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-attr={triggerDataAttr}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-11 w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-left",
          className,
        )}
      >
        {trigger}
      </button>
      <PhoneBottomSheet
        id={listId}
        open={open}
        onClose={close}
        title={title}
        meta={meta}
        triggerRef={triggerRef}
        dataAttr={sheetDataAttr}
        closeDataAttr={closeDataAttr}
        rootProps={rootProps}
      >
        <div
          role={linkMode ? undefined : "listbox"}
          aria-label={controlsLabel ?? title}
          className="pb-2"
        >
          {groups
            .filter((group) => group.items.length > 0)
            .map((group, groupIndex) => (
              <div key={group.label || group.items[0]?.id || groupIndex}>
                {group.label ? (
                  <div
                    className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"
                    data-attr={groupDataAttr ? `${groupDataAttr}-${group.label}` : undefined}
                  >
                    {group.label}
                  </div>
                ) : null}
                {group.items.map((item) => {
                  const body = (
                    <>
                      {item.label}
                      {item.srHint ? <span className="sr-only"> {item.srHint}</span> : null}
                    </>
                  );
                  if (item.href) {
                    return (
                      <Link
                        key={item.id}
                        href={item.href}
                        aria-current={item.current ? ariaCurrent === "page" ? "page" : "step" : undefined}
                        data-attr={item.dataAttr}
                        data-current={item.current || undefined}
                        className={PHONE_SHEET_ROW_CLASS}
                        onClick={() => {
                          item.onSelect?.();
                          close();
                        }}
                      >
                        <PhoneSheetRowBody current={Boolean(item.current)} glyph={item.glyph} trailing={item.trailing}>
                          {body}
                        </PhoneSheetRowBody>
                      </Link>
                    );
                  }
                  return (
                    <PhoneSheetRow
                      key={item.id}
                      current={item.current}
                      glyph={item.glyph}
                      trailing={item.trailing}
                      disabled={item.disabled}
                      aria-selected={Boolean(item.current)}
                      aria-current={item.current ? ariaCurrent : undefined}
                      data-attr={item.dataAttr}
                      onClick={() => {
                        close();
                        item.onSelect?.();
                      }}
                    >
                      {body}
                    </PhoneSheetRow>
                  );
                })}
              </div>
            ))}
        </div>
      </PhoneBottomSheet>
    </>
  );
}
