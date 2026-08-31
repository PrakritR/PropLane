"use client";

import { useEffect, useRef } from "react";
import { DestinationNav, type DestinationNavItem } from "@/components/ui/destination-nav";
import { syncPortalDetailDestinationOffset, syncPortalMobileTopChrome } from "@/lib/portal-mobile-top-chrome";
import { cn } from "@/lib/utils";

/**
 * Record-detail tab row (Preview, House details, …) — pinned with page chrome when
 * the parent uses {@link PortalRecordDetailPage} `pinScrollBody`.
 */
export function PortalDetailDestinationNav({
  items,
  activeId,
  activeHref,
  ariaLabel,
  className,
  denseEqualRow = false,
  centerEqualRow = false,
  appearance = "segmented",
}: {
  items: DestinationNavItem[];
  activeId?: string;
  activeHref?: string;
  ariaLabel?: string;
  className?: string;
  /** Property detail top tabs — one row with smaller labels on phones. */
  denseEqualRow?: boolean;
  /** Center equal-width tabs (Preview / House details sub-row). */
  centerEqualRow?: boolean;
  /** `command` = underline tabs (property detail top row). */
  appearance?: "segmented" | "command";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      syncPortalMobileTopChrome(el);
      syncPortalDetailDestinationOffset(el);
    };
    sync();
    const ro = new ResizeObserver(sync);
    const main = el.closest("#portal-main-content");
    const mobileBar = main?.querySelector(".portal-mobile-nav-bar");
    if (mobileBar) ro.observe(mobileBar);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      syncPortalMobileTopChrome(null);
    };
  }, []);

  return (
    <div
      className="w-full min-w-0 bg-background"
      data-portal-detail-destination-nav
      ref={wrapRef}
    >
      <DestinationNav
        items={items}
        activeId={activeId}
        activeHref={activeHref}
        ariaLabel={ariaLabel}
        itemLayout="equal"
        denseEqualRow={denseEqualRow}
        centerEqualRow={centerEqualRow}
        appearance={appearance}
        className={cn(
          appearance === "command"
            ? "border-b border-border"
            : "max-lg:rounded-none max-lg:border-0 max-lg:border-b max-lg:border-border max-lg:bg-transparent max-lg:p-0",
          className,
        )}
      />
    </div>
  );
}
