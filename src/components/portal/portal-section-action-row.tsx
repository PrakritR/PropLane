"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { PAGE_HEADER_TITLE_CLASS } from "@/components/ui/page-header";

const PORTAL_FOOTER_INLINE_ACTIONS_ROW = cn(
  "flex max-w-full min-w-0 shrink-0 flex-nowrap items-center justify-start gap-1 pb-0.5",
  PORTAL_HORIZONTAL_SCROLL_ROW_CLASS,
  "overscroll-x-contain scroll-px-1 sm:justify-end sm:gap-2 sm:pb-0",
);

// The row lives in a `position: fixed` dock, so buttons that can neither wrap
// nor shrink would otherwise run off the side of a narrow phone with nothing to
// scroll. It scrolls horizontally instead — overflow stays reachable.
// Adaptive footers measure available width and tuck overflow into … — horizontal
// scroll here hid buttons on the right even when the row had room on web.
const PORTAL_FOOTER_HEADER_ACTIONS_ROW = cn(
  "flex w-full min-w-0 shrink-0 flex-nowrap items-center justify-start gap-2 overflow-hidden pb-0.5 sm:pb-0",
  "[&_button]:w-auto [&_button]:max-w-none [&_button]:shrink-0 [&_label]:w-auto [&_label]:max-w-none [&_label]:shrink-0",
);

const PORTAL_FOOTER_INLINE_SPACER =
  "h-[calc(2.5rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] shrink-0 md:hidden";

/**
 * Page title row — page title (and optional trailing tabs) on the left;
 * filter + primary actions grouped on the right (dropdown opens leftward from filter).
 *
 * Renders at EVERY breakpoint, not desktop only: `ManagerPortalPageShell` collapsed its old
 * mobile `PageHeader` / desktop band pair onto this one band. So an ungated `actions` node
 * already reaches phones from here — pairing one with a {@link PortalPageHeaderMobileActionsRow}
 * draws it twice. See that component for the two legal shapes.
 */
export function PortalPageTitleBand({
  title,
  count,
  filter,
  actions,
  titleTrailing,
  className,
  hideTitleOnMobileNav = false,
}: {
  title: string;
  count?: number;
  filter?: ReactNode;
  actions?: ReactNode;
  titleTrailing?: ReactNode;
  className?: string;
  /** When the mobile nav bar already shows the section name, drop the duplicate h1 on phones. */
  hideTitleOnMobileNav?: boolean;
}) {
  const headerActions = filter || actions ? (
    filter && actions ? (
      <div className="flex shrink-0 flex-nowrap items-center gap-3 sm:gap-4">
        <div className="shrink-0">{filter}</div>
        <PortalSectionActionRow variant="header" className="min-w-0 flex-1 gap-2 sm:gap-3">
          {actions}
        </PortalSectionActionRow>
      </div>
    ) : (
      <PortalSectionActionRow
        variant="header"
        className={cn(
          "min-w-0 w-full shrink justify-start gap-0.5 sm:gap-0.5",
          hideTitleOnMobileNav && "max-lg:flex-1 lg:min-w-0 lg:flex-1",
        )}
      >
        {filter}
        {actions}
      </PortalSectionActionRow>
    )
  ) : null;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-3 sm:gap-4",
        hideTitleOnMobileNav ? "max-lg:min-w-0 lg:justify-between" : "flex-nowrap justify-between",
        className,
      )}
      data-slot="portal-page-title-band"
      {...(hideTitleOnMobileNav ? { "data-hide-title-on-mobile-nav": "" } : {})}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden sm:gap-2",
          hideTitleOnMobileNav ? "max-lg:hidden shrink-0" : "min-w-0 flex-1",
        )}
      >
        <h1 className={cn(PAGE_HEADER_TITLE_CLASS, "shrink-0")}>
          {title}
        </h1>
        {titleTrailing ? (
          <div className="min-w-0 flex-1 overflow-hidden">{titleTrailing}</div>
        ) : null}
      </div>
      {headerActions ? (
        <div
          className={cn(
            "flex min-w-0 items-center overflow-hidden",
            hideTitleOnMobileNav && "max-lg:min-w-0 max-lg:flex-1 max-lg:justify-start lg:min-w-0 lg:flex-1 lg:justify-start",
            !hideTitleOnMobileNav && "shrink-0",
          )}
          data-portal-action-slot=""
        >
          {headerActions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mobile — filter + primary actions grouped on the right (below the nav title).
 *
 * Only for the SPLIT shape: a `hidden md:flex` `titleAside` (so {@link PortalPageTitleBand}
 * contributes nothing on a phone) paired with this `md:hidden` row. A section whose
 * `titleAside` is ungated is BAND-ONLY and must not render this — that mix shipped two
 * overlapping CTAs on resident Applications and Tour. Deleting the row from a split-shape
 * section is the worse failure: zero controls on a phone. Guard:
 * `tests/unit/portal-inline-title-band-duplicate-controls.test.tsx`.
 */
export function PortalPageHeaderMobileActionsRow({
  filter,
  actions,
  className,
}: {
  filter?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!filter && !actions) return null;

  return (
    <div
      className={cn(
        "mb-2 flex w-full min-w-0 flex-nowrap items-center justify-end gap-2 sm:gap-2.5 md:hidden",
        className,
      )}
      data-slot="portal-page-header-mobile-actions"
    >
      {filter ? <div className="shrink-0">{filter}</div> : null}
      {actions ? (
        <div className="flex shrink-0 flex-nowrap items-center gap-1.5 sm:gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

const PORTAL_FOOTER_PINNED_SPACER =
  "h-[calc(3.5rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] shrink-0";

/** Fixed primary CTAs above the native bottom tab bar (Create, Add resident, Add payment, …). */
export function PortalPageFooterActions({
  children,
  className,
  /** `header` keeps compact pills in one horizontal row on mobile (resident detail footers). */
  rowVariant = "toolbar",
  /** Keep the white dock fixed on every breakpoint (resident profile sections). */
  pinned = false,
}: {
  children: ReactNode;
  className?: string;
  rowVariant?: "toolbar" | "header";
  pinned?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden
        className={
          pinned
            ? PORTAL_FOOTER_PINNED_SPACER
            : rowVariant === "header"
              ? PORTAL_FOOTER_INLINE_SPACER
              : "h-[calc(4.25rem+var(--portal-native-bottom-nav-inset,0px))] shrink-0 md:hidden"
        }
      />
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background shadow-[var(--shadow-lg)]",
          pinned ? "bg-background/98 backdrop-blur-sm" : "bg-background/95 backdrop-blur-md",
          rowVariant === "header" ? "px-2 py-2 max-md:pb-2" : "px-4 py-3",
          "pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]",
          "max-lg:bottom-[var(--portal-native-bottom-nav-inset,0px)]",
          !pinned &&
            "md:static md:inset-auto md:z-auto md:border-0 md:bg-transparent md:px-0 md:py-0 md:shadow-none md:backdrop-blur-none",
          className,
        )}
        data-slot="portal-page-footer-actions"
        data-row-variant={rowVariant}
        data-pinned={pinned ? "" : undefined}
      >
        <div className="mx-auto w-full min-w-0 max-w-5xl">
          {rowVariant === "header" ? (
            <div className={PORTAL_FOOTER_HEADER_ACTIONS_ROW}>{children}</div>
          ) : (
            <div {...{ [HORIZONTAL_SCROLL_ATTR]: "" }}>
              <PortalSectionActionRow>{children}</PortalSectionActionRow>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Appendix C3 — one alignment rule for section action rows:
 * mobile: full-width / evenly distributed in the thumb arc;
 * desktop: start-aligned with section content, primary last, destructive separated.
 */
export function PortalSectionActionRow({
  children,
  className,
  destructive,
  /** Inline beside the page title (Share / Create, New message). */
  variant = "toolbar",
}: {
  children: ReactNode;
  className?: string;
  /** When set, renders destructive actions in a separated trailing group. */
  destructive?: ReactNode;
  variant?: "toolbar" | "header" | "grid";
}) {
  if (variant === "header") {
    return (
      <div
        className={cn(
          "flex min-w-0 flex-nowrap items-center gap-2 sm:gap-3",
          "md:[&_button]:box-border md:[&_button]:h-10 md:[&_button]:min-h-0",
          "[&_button]:w-auto [&_button]:max-w-none [&_button]:shrink-0 [&_a]:w-auto",
          "max-lg:[&_button]:!w-auto",
          className,
        )}
        data-slot="portal-section-action-row"
        data-variant="header"
      >
        {children}
      </div>
    );
  }

  if (variant === "grid") {
    return (
      <div
        className={cn(
          "grid w-full grid-cols-2 gap-x-2 gap-y-3",
          "md:flex md:flex-wrap md:items-center md:justify-end md:gap-2",
          "[&_button]:w-full md:[&_button]:w-auto",
          className,
        )}
        data-slot="portal-section-action-row"
        data-variant="grid"
      >
        {children}
        {destructive ? (
          <div
            className={cn(
              "col-span-2 flex w-full md:col-span-1 md:ml-0.5 md:w-auto md:border-l md:border-border md:pl-2",
              "[&_button]:w-full md:[&_button]:w-auto",
            )}
            data-slot="portal-section-action-row-destructive"
          >
            {destructive}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2",
        "max-sm:[&_button]:w-full max-sm:[&_a]:w-full",
        className,
      )}
      data-slot="portal-section-action-row"
    >
      <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:[&_button]:w-auto sm:[&_a]:w-auto">
        {children}
      </div>
      {destructive ? (
        <div
          className={cn(
            "flex w-full min-w-0 flex-col gap-3 border-t border-border pt-3 sm:ml-auto sm:w-auto sm:flex-row sm:border-0 sm:border-l sm:pl-3 sm:pt-0",
            "max-sm:[&_button]:w-full sm:[&_button]:w-auto",
          )}
          data-slot="portal-section-action-row-destructive"
        >
          {destructive}
        </div>
      ) : null}
    </div>
  );
}
