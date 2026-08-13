"use client";

import type { ReactNode } from "react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { useCommunicationSurfaceChrome } from "@/hooks/use-communication-surface-chrome";
import { cn } from "@/lib/utils";

/**
 * Communication page chrome — Appendix C1 control stack above the inbox body.
 */
export function PortalCommunicationShell({
  title,
  controlStack,
  /** @deprecated Prefer `controlStack`. Kept for resident/vendor/admin shells. */
  titleAside,
  titleInlineFilter,
  /** @deprecated Prefer `controlStack`. */
  threadFilters,
  children,
  hideMobileFilterRow = false,
  compactFilterRow = true,
  mobileThreadReading = false,
  threadSelected = false,
  hideTitleOnMobileNav = true,
  hideAssistantFab = false,
}: {
  title: string;
  controlStack?: ReactNode;
  titleAside?: ReactNode;
  titleInlineFilter?: ReactNode;
  threadFilters?: ReactNode;
  children: ReactNode;
  hideMobileFilterRow?: boolean;
  compactFilterRow?: boolean;
  mobileThreadReading?: boolean;
  /** Any open conversation (desktop split or mobile) — hides the assistant FAB. */
  threadSelected?: boolean;
  hideTitleOnMobileNav?: boolean;
  /** Hide the floating assistant FAB for the whole Communication tab. */
  hideAssistantFab?: boolean;
}) {
  const resolvedStack =
    controlStack ??
    (threadFilters ? <PortalListControlStack filterRow={threadFilters} /> : null);

  useCommunicationSurfaceChrome({
    active: true,
    threadReading: mobileThreadReading,
    threadSelected,
    hideAssistantFab,
  });

  return (
    <ManagerPortalPageShell
      title={title}
      titleAside={titleAside}
      titleInlineFilter={titleInlineFilter}
      hideTitleOnMobileNav={hideTitleOnMobileNav}
      compactFilterRow={compactFilterRow}
      mobileHideFilterRow={hideMobileFilterRow}
      mobileFlush={mobileThreadReading}
      viewportFillBody
      stickyPageChrome={false}
    >
      {resolvedStack ? (
        <div
          className={hideMobileFilterRow ? "mb-2 shrink-0 max-md:hidden" : "mb-2 shrink-0"}
          data-portal-communication-chrome
        >
          {resolvedStack}
        </div>
      ) : null}
      <div
        className={cn(
          "portal-communication-inbox flex min-h-0 min-w-0 flex-1 flex-col max-md:mt-0 max-md:-mx-0.5 md:mt-1",
        )}
      >
        {children}
      </div>
    </ManagerPortalPageShell>
  );
}
