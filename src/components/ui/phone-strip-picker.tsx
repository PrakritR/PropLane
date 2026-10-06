"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { PhoneSectionPicker, type PhonePickerItem } from "@/components/ui/phone-bottom-sheet";

/**
 * A tab strip that does not fit on a phone becomes the record page's dropdown section picker
 * (captain, 2026-10-06). One rule, in one place:
 *
 *   - inside a record page or a pop-up (`PhoneStripPickerScope`), a command (underline) strip
 *     whose labels cannot share one phone screen draws the picker on a phone (< 640px) instead
 *     of a sideways-scrolling row. The strip stays in the DOM, hidden, so nothing that targets it breaks;
 *   - a strip that fits stays tabs, and from 640px up nothing changes.
 *
 * "Fits" is decided from the labels, not measured: the answer has to be the same on the server and
 * in the first paint (no tabs that turn into a picker), and a 390px phone is the width to hold.
 */
const PhoneStripPickerContext = createContext(false);

/** Marks everything inside as a record page or pop-up, whose overflowing strips become the picker. */
export function PhoneStripPickerScope({ children }: { children: ReactNode }) {
  return <PhoneStripPickerContext.Provider value>{children}</PhoneStripPickerContext.Provider>;
}

/** The room a strip has on a 390px phone, inside a card's padding. Narrower phones simply scroll less. */
export const PHONE_STRIP_FIT_PX = 336;

export type PhoneStripTab = {
  label: string;
  /** A count pill after the label. */
  count?: number;
  /** Extra glyph width (a check or an attention dot). */
  glyphs?: number;
};

/** Width a command strip needs: 14px semibold text, plus each tab's padding, gap and count pill. */
export function estimatePhoneStripWidth(tabs: readonly PhoneStripTab[]): number {
  return tabs.reduce(
    (total, tab) => total + tab.label.length * 7 + (tab.count != null ? 55 : 32) + (tab.glyphs ?? 0) * 18,
    0,
  );
}

export function phoneStripFits(tabs: readonly PhoneStripTab[]): boolean {
  return estimatePhoneStripWidth(tabs) <= PHONE_STRIP_FIT_PX;
}

/** True when this strip should be the picker on a phone: in scope, and too wide for one screen. */
export function usePhoneStripAsPicker(enabled: boolean, tabs: readonly PhoneStripTab[]): boolean {
  const inScope = useContext(PhoneStripPickerContext);
  return enabled && inScope && !phoneStripFits(tabs);
}

/**
 * The picker itself — the same `PhoneSectionPicker` the record page uses (closed: the current
 * section and a chevron; open: the shared bottom sheet). Phone only.
 */
export function PhoneStripPicker({
  title,
  items,
  currentLabel,
  dataAttr,
  className,
  variant = "field",
}: {
  title: string;
  items: PhonePickerItem[];
  currentLabel: ReactNode;
  dataAttr?: string;
  className?: string;
  /**
   * `field` is the record page's own full-width dropdown. `inline` sits in a header card beside its
   * icon actions: the current section as the active blue tab, with a chevron.
   */
  variant?: "field" | "inline";
}) {
  return (
    <div className={className ?? "sm:hidden"} data-attr={dataAttr ?? "phone-strip-picker"}>
      <PhoneSectionPicker
        title={title}
        controlsLabel={title}
        ariaCurrent="page"
        triggerDataAttr="phone-strip-picker-toggle"
        closeDataAttr="phone-strip-picker-close"
        className={
          variant === "inline"
            ? "w-auto justify-start gap-1.5 rounded-none border-0 border-b-2 border-primary bg-transparent px-2.5 text-sm font-semibold text-primary"
            : "justify-between px-4 text-[14.5px] font-semibold text-foreground"
        }
        trigger={
          <>
            <span className={variant === "inline" ? "min-w-0 truncate" : "min-w-0 flex-1 truncate"}>{currentLabel}</span>
            <ChevronDown className={variant === "inline" ? "size-4 shrink-0" : "size-4 shrink-0 text-muted"} aria-hidden />
          </>
        }
        groups={[{ items }]}
      />
    </div>
  );
}

/** Wraps the real strip so a phone can swap it for the picker without the strip leaving the DOM. */
export function PhoneStripOrPicker({
  strip,
  picker,
}: {
  strip: ReactNode;
  picker: ReactNode;
}) {
  return (
    <>
      <div className="max-sm:hidden sm:contents">{strip}</div>
      {picker}
    </>
  );
}
