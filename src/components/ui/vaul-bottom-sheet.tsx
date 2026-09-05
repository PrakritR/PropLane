"use client";

import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { X } from "lucide-react";
import { MODAL_HEADER_CLOSE_CLASS } from "@/components/ui/modal";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { isPortaledFieldSelectMenuTarget } from "@/components/ui/field-select-portal-interaction";
import { cn } from "@/lib/utils";

/**
 * Single source of the raised-sheet offset. It is published as a custom property on the
 * elevated sheet so the placement (`bottom`), the max-height, and vaul's exit distance
 * (`--initial-transform`) all read the SAME number — three literal copies of this
 * expression would drift, and a sheet placed by one number and animated by another slides
 * off screen short and then unmounts abruptly.
 */
const RAISED_SHEET_OFFSET_VAR = "--portal-raised-sheet-offset";
const RAISED_SHEET_OFFSET =
  "max(32vh, calc(var(--portal-native-bottom-nav-inset, 0px) + 6rem))";

/**
 * Vaul's `slideFromBottom` / `slideToBottom` keyframes both translate by
 * `var(--initial-transform, 100%)` — 100% of the DRAWER's own height, which clears the
 * viewport only for a bottom-anchored drawer. A raised sheet has to travel its own height
 * PLUS the gap it leaves below itself, or it ends the close animation still on screen.
 * This is vaul's own escape hatch for offset drawers; resetting the placement on close
 * instead would reintroduce the mid-interaction jump this component exists to remove.
 */
const RAISED_SHEET_STYLE = {
  [RAISED_SHEET_OFFSET_VAR]: RAISED_SHEET_OFFSET,
  "--initial-transform": `calc(100% + var(${RAISED_SHEET_OFFSET_VAR}))`,
} as CSSProperties;

/**
 * Vaul ships `[data-vaul-drawer]{touch-action:none}`, and a browser resolves touch-action by
 * INTERSECTING the values up the ancestor chain — so `none` on the drawer disables finger
 * panning for every descendant, no matter that the scroll region itself says `auto`. A
 * sheet taller than the viewport therefore scrolled with a mouse wheel and not with a
 * thumb, which is the only way anyone actually uses it. `pan-y` restores vertical scrolling
 * while still blocking the horizontal pans vaul does not want; drag-to-dismiss is
 * unaffected because every sheet here is `handleOnly`, so a drag can only start on
 * `[data-vaul-handle]`, which carries its own `touch-action`.
 */
const SHEET_TOUCH_ACTION: CSSProperties = { touchAction: "pan-y" };

/** Keep portaled FieldSingleSelect / CheckboxMultiSelect menus clickable inside sheets. */
function allowPortaledFieldSelectInteraction(event: Event) {
  if (isPortaledFieldSelectMenuTarget(event.target)) {
    event.preventDefault();
  }
}

/**
 * Mobile bottom sheet (Vaul + Radix Dialog) — drag handle, snap points, safe area.
 * Desktop callers should use centred {@link Modal} instead.
 */
export function VaulBottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  fullScreen = false,
  /**
   * When true the sheet sits in the RAISED position (filter panels) instead of hugging the
   * bottom nav. This is unconditional on purpose: it used to be gated on a
   * `height < viewport * 0.52` measurement, so a sheet that grew or shrank while open —
   * which is exactly what an opening filter dropdown used to do — flipped the placement and
   * the whole sheet visibly JUMPED up mid-interaction. A fixed placement cannot jump.
   * The elevated max-height is derived from the same offset so a tall sheet still fits on
   * screen instead of running off the top, which is what the measurement was guarding.
   */
  autoElevate = false,
  flushBody = false,
  lockBodyScroll = false,
  /**
   * Override the bottom-anchored default (88dvh, capped to the viewport above the tab-bar
   * inset) for tall filter sheets. IGNORED when
   * `autoElevate` is set: an elevated sheet derives its max-height from the raised offset,
   * and letting a caller's `max-h-*` reach the same element would make the sheet's height
   * depend on which of two sources won a merge rather than on the placement it is in. Only
   * pass this on a bottom-anchored sheet.
   */
  maxHeightClass,
  /**
   * Bottom-anchored sheets only: open at the same height as `maxHeightClass` so the card
   * background fills down to the tab bar instead of hugging field content with a gap below.
   */
  fillViewport = false,
  /**
   * Floor height for the RAISED sheet, so a portaled menu can always be contained inside it
   * rather than hanging onto the scrim. Clamped against the raised max-height, so a short
   * viewport can never push the sheet's top off screen. Ignored unless `autoElevate`.
   */
  minHeightPx,
  /**
   * When false, the sheet cannot be dismissed by dragging or tapping the overlay —
   * only the header ✕ (or an explicit `onOpenChange(false)` from the caller) closes it.
   */
  dismissible = true,
  assistantStrip,
  assistantContext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  fullScreen?: boolean;
  autoElevate?: boolean;
  flushBody?: boolean;
  /** When true, the sheet body does not scroll (e.g. an open filter field menu). */
  lockBodyScroll?: boolean;
  maxHeightClass?: string;
  fillViewport?: boolean;
  minHeightPx?: number;
  dismissible?: boolean;
  /** Pass `false` to hide the in-sheet assistant (e.g. payment flows). */
  assistantStrip?: boolean;
  assistantContext?: string;
}) {
  const portalAssistant = usePortalAssistantConfig();
  const showAssistantStrip = assistantStrip !== false && portalAssistant != null;
  const assistantHint =
    assistantContext?.trim() ||
    (typeof title === "string" ? title.trim() : "") ||
    "Portal sheet";
  const [assistantConversationInstance, setAssistantConversationInstance] = useState(1);
  const [assistantTriggerTarget, setAssistantTriggerTarget] = useState<HTMLSpanElement | null>(null);
  const wasOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      setAssistantConversationInstance((n) => n + 1);
    }
    wasOpenRef.current = open;
  }, [open]);
  const contentHugging = !fullScreen && !fillViewport;
  const elevated = autoElevate && !fullScreen;
  const bottomAnchoredMaxHeight =
    maxHeightClass ??
    "max-h-[min(88dvh,calc(100dvh-var(--portal-native-bottom-nav-inset,0px)-0.5rem))]";
  const bottomAnchoredMinHeight = fillViewport
    ? bottomAnchoredMaxHeight.replace(/^max-h-/, "min-h-")
    : undefined;

  /* One raised placement, applied statically. The elevated `bottom` and max-height each
     REPLACE the bottom-anchored ones: exactly one branch emits a `bottom-*` and exactly one
     emits a `max-h-*`, so the two placements are mutually exclusive and each is assertable on
     its own. `cn()` is `twMerge(clsx(...))`, so duplicates WOULD collapse to the last one
     rather than fight — the point of the split is not to break a tie, it is that a single
     emitted utility per property is what lets a test pin the placement (and with it
     containment and the uncoverable chrome) instead of pinning a merge outcome. That is why
     the bottom-anchored `bottom-[var(--portal-native-bottom-nav-inset,0px)]` lives on the
     non-elevated branch below rather than in the base class list.
     Both of these read {@link RAISED_SHEET_OFFSET_VAR}. */
  const elevatedPlacement =
    "bottom-[var(--portal-raised-sheet-offset)] top-auto " +
    "max-h-[calc(100dvh-var(--portal-raised-sheet-offset)-1rem)]";

  /* `min()` against the same raised max-height, not a bare pixel floor: on a short viewport
     a bare floor would out-rank max-height (min-height always wins) and push the sheet's
     top off screen.

     Below roughly 575px of viewport height the clamp arm wins and the floor is NOT reached,
     so a menu can no longer be contained and shows as many rows as fit while overhanging the
     sheet. That is an accepted degradation, not an oversight — the arithmetic, the measured
     844x390 numbers, and why the still-intact chrome guard makes it acceptable are recorded
     beside `PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX` in
     `src/components/portal/filter-field-lists.tsx`. Read that before retuning either number. */
  const raisedMinHeight =
    elevated && minHeightPx
      ? {
          minHeight: `min(${minHeightPx}px, calc(100dvh - var(${RAISED_SHEET_OFFSET_VAR}) - 1rem))`,
        }
      : undefined;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} handleOnly dismissible={dismissible}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/50 motion-reduce:transition-none" />
        <Drawer.Content
          className={cn(
            "fixed inset-x-0 z-[71] flex !w-screen !max-w-none flex-col overflow-visible border-x-0 border-t border-border bg-background outline-none motion-reduce:transition-none",
            fullScreen
              ? "inset-0 top-0 z-[71] flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden rounded-none border-0 pt-[max(0.75rem,var(--native-safe-top,0px))] pb-[max(1rem,var(--native-safe-bottom,0px))]"
              : cn(
                  "h-auto rounded-none",
                  elevated
                    ? elevatedPlacement
                    : cn(
                        "bottom-[var(--portal-native-bottom-nav-inset,0px)]",
                        bottomAnchoredMaxHeight,
                        bottomAnchoredMinHeight,
                      ),
                ),
            !footer && "pb-[max(1rem,var(--native-safe-bottom,0px))]",
          )}
          style={
            elevated
              ? { ...RAISED_SHEET_STYLE, ...SHEET_TOUCH_ACTION, ...raisedMinHeight }
              : SHEET_TOUCH_ACTION
          }
          data-slot="vaul-bottom-sheet"
          data-elevated={elevated ? "true" : "false"}
          data-full-screen={fullScreen ? "true" : "false"}
          onPointerDownOutside={allowPortaledFieldSelectInteraction}
          onInteractOutside={allowPortaledFieldSelectInteraction}
          onFocusOutside={allowPortaledFieldSelectInteraction}
        >
          {!fullScreen ? (
            <Drawer.Handle className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
          ) : null}
          {/* Title + close: fixed chrome a portaled field menu must never cover, or the
              sheet loses its only visible dismiss control on a phone. */}
          <div
            data-field-select-host-chrome=""
            className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 pb-3 pt-2"
          >
            <div className="min-w-0 flex-1">
              <Drawer.Title className="text-base font-semibold text-foreground">{title}</Drawer.Title>
              {description ? (
                <Drawer.Description className="mt-1 text-sm text-muted">{description}</Drawer.Description>
              ) : null}
            </div>
            <span ref={setAssistantTriggerTarget} className="shrink-0" />
            <Drawer.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className={MODAL_HEADER_CLOSE_CLASS}
                onClick={() => onOpenChange(false)}
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </Drawer.Close>
          </div>
          {/* `min-h-0` rather than `shrink-0`: a hugging sheet still sizes to its content
              (`flex: 0 1 auto`), but once that content exceeds the sheet's max-height it
              shrinks and scrolls INSIDE the sheet. With `shrink-0` it overflowed the sheet
              instead, which is why callers had to hand-cap their body height and why a
              four-field filter pushed its last fields past the sheet's bottom edge. */}
          <div className={cn("flex min-h-0 flex-col", fillViewport && "flex-1")}>
            <div
              className={cn(
                flushBody ? "px-0" : "px-4",
                "py-3",
                "min-h-0",
                lockBodyScroll
                  ? "overflow-hidden"
                  : "overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]",
                fillViewport || !contentHugging ? "flex-1" : undefined,
              )}
            >
              {children}
            </div>
            {showAssistantStrip ? (
              <ModalAssistantStrip
                contextHint={assistantHint}
                storageScopeKey={assistantHint}
                conversationInstance={assistantConversationInstance}
                triggerTarget={assistantTriggerTarget}
              />
            ) : null}
            {footer ? (
              <div className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
                {footer}
              </div>
            ) : null}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
