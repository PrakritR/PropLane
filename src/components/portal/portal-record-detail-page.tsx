"use client";

import type { ReactNode } from "react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePortalStickyPageChrome } from "@/hooks/use-portal-sticky-page-chrome";
import { cn } from "@/lib/utils";

/**
 * Full-page record detail (Appendix E2) — no split list pane; URL is the lease route.
 */
export function PortalRecordDetailPage({
  pageTitle: _pageTitle,
  title,
  subtitle,
  avatarName,
  backHref,
  backLabel,
  hideBackText = false,
  hideBack = false,
  bareHeader = false,
  actions,
  suppressMobileActions = false,
  inlineActions = false,
  inlineActionsClassName,
  children,
  fillBody = false,
  /**
   * Pin the back header (and optional in-page tab chrome) while the body scrolls
   * below — same model as list sections (Applications, Properties, Calendar).
   */
  pinScrollBody = false,
  /**
   * When `pinScrollBody`, wrap `children` in {@link PortalPageScrollBody}. Set
   * false when children supply their own chrome + scroll split (property detail).
   */
  scrollBody = true,
  dataAttrBack = "portal-record-detail-back",
  /** Pinned bottom bar (Pay, Download, …) — same pattern as resident profile detail tabs. */
  footer,
  /** Scroll clearance lives on the scroller — skip the in-flow spacer band above a pinned footer. */
  footerOmitSpacer = false,
}: {
  /** @deprecated Detail chrome no longer renders a duplicate section title. */
  pageTitle?: string;
  title: string;
  subtitle?: string;
  avatarName?: string;
  backHref?: string;
  backLabel?: string;
  hideBackText?: boolean;
  /** Omit the back control entirely (detail stays in-context). */
  hideBack?: boolean;
  bareHeader?: boolean;
  actions?: ReactNode;
  suppressMobileActions?: boolean;
  inlineActions?: boolean;
  inlineActionsClassName?: string;
  children: ReactNode;
  /**
   * Opt in when `children` is a self-contained fill layout (a chat pane that
   * scrolls internally) rather than flowing content.
   *
   * The default body wrapper is a BLOCK, which severs a `flex-1` chain: a child
   * asking to fill gets no definite height and lays out at its content height
   * instead. On a fixed-chrome surface (`data-communication-surface` clips
   * `#portal-main-content` and `.portal-main-inner`) that overflow is not
   * scrollable, so the header — including this component's own back button — is
   * pushed out of a page that cannot scroll back. Opt-in so the ~10 flowing
   * detail pages keep block layout unchanged.
   */
  fillBody?: boolean;
  pinScrollBody?: boolean;
  scrollBody?: boolean;
  dataAttrBack?: string;
  footer?: ReactNode;
  footerOmitSpacer?: boolean;
}) {
  const navigate = usePortalNavigate();
  usePortalStickyPageChrome(pinScrollBody);
  const bodyFill = fillBody || pinScrollBody;
  const body = pinScrollBody && scrollBody && !fillBody ? (
    <PortalPageScrollBody>{children}</PortalPageScrollBody>
  ) : (
    children
  );
  return (
    <div className={cn("flex min-h-0 flex-col", bodyFill && "flex-1")}>
      <div className={pinScrollBody ? "shrink-0" : undefined}>
      <PortalDetailHeader
        title={title}
        subtitle={subtitle}
        avatarName={avatarName}
        onBack={hideBack || !backHref ? undefined : () => navigate(backHref)}
        backLabel={backLabel ?? "Back"}
        hideBackText={hideBackText}
        bare={bareHeader}
        dataAttrBack={dataAttrBack}
        actions={actions}
        suppressMobileActions={suppressMobileActions}
        inlineActions={inlineActions}
        inlineActionsClassName={inlineActionsClassName}
      />
      </div>
      <div className={cn(bodyFill && "flex min-h-0 flex-1 flex-col")}>{body}</div>
      {footer ? (
        <PortalPageFooterActions pinned rowVariant="header" omitSpacer={footerOmitSpacer}>
          {footer}
        </PortalPageFooterActions>
      ) : null}
    </div>
  );
}
