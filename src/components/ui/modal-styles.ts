/** Opaque modal shell — solid card surface so background content does not bleed through.
 * Native cap subtracts the notch / home-indicator safe areas (85dvh centered can push the
 * header under the status bar on tall phones); the wrapper in `Modal` pads by the same
 * insets so the panel always sits inside the visible viewport. */
export const MODAL_PANEL_CLASS =
  "modal-panel relative flex max-h-[min(92dvh,56rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border p-5 shadow-[var(--shadow-card)] sm:p-6 [html[data-native]_&]:max-h-[calc(100dvh-max(1rem,var(--native-safe-top))-max(1rem,var(--native-safe-bottom))-1rem)]";

/** Bordered inset panel for message previews, link URLs, and read-only blocks inside modals. */
export const MODAL_INSET_BOX_CLASS =
  "rounded-xl border border-border bg-accent/30 p-3 text-sm leading-relaxed text-muted";

export const MODAL_INSET_BOX_PRE_CLASS = `${MODAL_INSET_BOX_CLASS} whitespace-pre-wrap`;

export const MODAL_WARNING_BOX_CLASS =
  "rounded-xl border px-3 py-2 text-sm leading-relaxed portal-banner-pending";

export const MODAL_FIELD_LABEL_CLASS = "text-xs font-semibold uppercase tracking-wide text-muted";

/** Modal forms in portal drawer (< lg): one column; desktop dialog: two columns. */
export const PORTAL_MODAL_FORM_GRID_CLASS =
  "grid min-w-0 max-w-full grid-cols-1 gap-3 lg:grid-cols-2";

export const PORTAL_MODAL_FORM_FIELD_CLASS = "flex min-w-0 flex-col gap-1 text-sm";

export const PORTAL_MODAL_FORM_FULL_ROW_CLASS = "lg:col-span-2";

export const MODAL_OVERLAY_BACKDROP_CLASS = "modal-overlay fixed inset-0";

/** Large centered dialog — previews, editors, multi-section forms. */
export const MODAL_LARGE_PANEL_CLASS = "max-w-4xl w-full";

/** Extra-wide centered dialog — listing preview, lease editor. */
export const MODAL_XL_PANEL_CLASS = "max-w-5xl w-full";

/** Tall editor dialog — fills the standard modal viewport height so body flex children can grow. */
export const MODAL_TALL_PANEL_CLASS = "h-[min(92dvh,56rem)] max-h-[min(92dvh,56rem)]";

/** Full-viewport modal shell — opt in with `fullPage` for rare immersive flows. */
export const MODAL_FULL_PAGE_STACK_CLASS = "fixed inset-0 z-[70] overflow-hidden";
export const MODAL_FULL_PAGE_CENTER_CLASS =
  "relative z-[71] flex min-h-full items-stretch justify-stretch p-0";
export const MODAL_FULL_PAGE_PANEL_CLASS =
  "modal-panel fixed inset-0 z-[71] flex !h-[100dvh] !max-h-[100dvh] !w-full !max-w-none flex-col overflow-hidden !rounded-none border-0 shadow-none outline-none pt-[max(0.75rem,var(--native-safe-top,0px))] pb-[max(1rem,var(--native-safe-bottom,0px))]";

/**
 * Mobile Vaul drawers must span the viewport width — caller `max-w-*` classes are for
 * desktop dialog only and must not letterbox a bottom sheet.
 */
export const PORTAL_MOBILE_DRAWER_EDGE_CLASS =
  "!left-0 !right-0 !w-screen !max-w-none border-x-0";

/** Partial-height portal bottom sheet shell (below `lg`). */
export const PORTAL_MOBILE_DRAWER_SHELL_CLASS =
  "modal-panel fixed inset-x-0 bottom-0 z-[71] flex flex-col overflow-hidden rounded-none border-t border-border shadow-[var(--shadow-card)] outline-none motion-reduce:transition-none pb-[max(1rem,var(--native-safe-bottom,0px))] !left-0 !right-0 !w-screen !max-w-none border-x-0";
