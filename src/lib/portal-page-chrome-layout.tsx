import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export const PORTAL_PAGE_SCROLL_BODY_CLASS = "portal-list-page-scroll";

export function PortalPageChrome({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`portal-page-chrome shrink-0 ${className}`.trim()}>{children}</div>;
}

export function PortalPageScrollBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${PORTAL_PAGE_SCROLL_BODY_CLASS} min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] ${className}`.trim()}>
      {children}
    </div>
  );
}

// `componentName` falls back to `Function.name`, which a production minifier
// mangles — the marker below is what keeps child detection working in a real build.
PortalPageChrome.displayName = "PortalPageChrome";
PortalPageScrollBody.displayName = "PortalPageScrollBody";

function componentName(type: unknown): string | null {
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  return null;
}

function isScrollBodyElement(el: ReactElement): boolean {
  if (componentName(el.type) === "PortalPageScrollBody") return true;
  const className = (el.props as { className?: string }).className ?? "";
  return className.includes(PORTAL_PAGE_SCROLL_BODY_CLASS);
}

function isListControlStackElement(el: ReactElement): boolean {
  return componentName(el.type) === "PortalListControlStack";
}

/** Split shell children into fixed chrome (title band is outside) vs scrollable body. */
export function partitionPortalPageChildren(children: ReactNode): {
  chrome: ReactNode[];
  body: ReactNode[];
} {
  const items = Children.toArray(children);
  let scrollIdx = items.findIndex((c) => isValidElement(c) && isScrollBodyElement(c));

  if (scrollIdx === -1) {
    let lastControlStack = -1;
    items.forEach((c, i) => {
      if (isValidElement(c) && isListControlStackElement(c)) lastControlStack = i;
    });
    if (lastControlStack >= 0) scrollIdx = lastControlStack + 1;
  }

  if (scrollIdx === -1) {
    return { chrome: [], body: items };
  }

  return {
    chrome: items.slice(0, scrollIdx),
    body: items.slice(scrollIdx),
  };
}

/** Merge shell title + primary CTA into the first command {@link PortalListControlStack}. */
export function injectUnifiedListChromeIntoChildren(
  children: ReactNode,
  inject: {
    title?: string;
    titleCount?: number;
    primaryAction?: ReactNode;
    hideTitleOnMobile?: boolean;
    skipTitle?: boolean;
  },
): { children: ReactNode; merged: boolean } {
  if (!inject.primaryAction) {
    return { children, merged: false };
  }
  let merged = false;
  const next = Children.map(children, (child) => {
    if (merged || !isValidElement(child)) return child;
    if (!isListControlStackElement(child)) return child;
    const variant = (child.props as { variant?: string }).variant ?? "stacked";
    if (variant !== "command") return child;
    merged = true;
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      chromeTitle: inject.skipTitle ? undefined : inject.title,
      chromeTitleCount: inject.skipTitle ? undefined : inject.titleCount,
      chromePrimaryAction: inject.primaryAction,
      chromeHideTitleOnMobile: inject.hideTitleOnMobile,
    });
  });
  return { children: next, merged };
}

export function renderPortalStickyBody(children: ReactNode): ReactNode {
  const { chrome, body } = partitionPortalPageChildren(children);

  const bodyContent = body.flatMap((node) => {
    if (isValidElement(node) && isScrollBodyElement(node)) {
      return Children.toArray((node.props as { children?: ReactNode }).children);
    }
    return [node];
  });

  return (
    <>
      {chrome.length > 0 ? (
        <div className="portal-page-chrome shrink-0">{chrome}</div>
      ) : null}
      <PortalPageScrollBody>{bodyContent}</PortalPageScrollBody>
    </>
  );
}
