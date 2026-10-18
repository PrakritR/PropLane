/**
 * Phone type scale for portal pop-ups (Apple HIG): field labels 13px, text links and
 * small actions a 44px target. Desktop keeps the shared modal label (12px) and the compact link.
 */
export const POPUP_FIELD_LABEL_CLASS =
  "text-[13px] font-semibold uppercase tracking-wide text-muted lg:text-xs";

/** An inline text action in a label row ("+ New resident"): 44px tall on a phone, link-sized on desktop. */
export const POPUP_FIELD_LINK_CLASS =
  "inline-flex items-center text-[14px] font-semibold normal-case tracking-normal text-primary hover:underline disabled:opacity-50 max-lg:min-h-11 max-lg:px-2 max-lg:-mr-2 lg:text-xs";
