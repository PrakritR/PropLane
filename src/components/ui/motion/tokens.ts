/**
 * Typed mirror of `tokens.css`'s durations, for the handful of call sites that
 * need a plain number (a `setTimeout`, a RAF loop, an `onceAnimationEnd`
 * fallback) rather than a CSS custom property. Keep the two files in sync by
 * hand — there are few enough tokens that a build-time generator would be
 * more machinery than the values are worth. See `tokens.css`'s own header for
 * where these numbers come from (interior.dev's source, ported verbatim).
 */
export const MOTION_MS = {
  fast: 120,
  base: 180,
  slow: 260,
  panel: 300,
  modalIn: 200,
  modalOut: 150,
  wizIn: 220,
  wizOut: 160,
} as const;

export const MOTION_EASE = {
  in: "cubic-bezier(0.23, 1, 0.32, 1)",
  out: "cubic-bezier(0.4, 0, 1, 1)",
  cell: "ease-out" /* --spring-snappy fallback */,
  crossfade: "cubic-bezier(0.22, 1, 0.36, 1)",
  nudge: "ease-out" /* --spring-snappy fallback */,
  fill: "cubic-bezier(0.16, 0.8, 0.3, 1)",
  disclose: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

/**
 * Spring easings for the Web Animations API, which cannot read the CSS custom
 * properties in `tokens.css`. Same `linear()` curves as `--spring-*` there, plus
 * the cubic-bezier each falls back to where `linear()` is unsupported.
 */
export const MOTION_SPRING = {
  snappy: "linear(0, 0.162, 0.421, 0.634, 0.781, 0.873, 0.929, 0.96, 0.978, 0.988, 0.994, 0.997, 0.998, 0.999, 1)",
  sheet: "linear(0, 0.172, 0.459, 0.698, 0.855, 0.943, 0.985, 1.002, 1.006, 1.006, 1.004, 1.002, 1.001, 1, 1)",
  snappyFallback: "ease-out",
  sheetFallback: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

/** Spring-handoff durations (ms) for sheet entrance, release and exit. */
export const SHEET_MS = { enter: 300, settle: 300, exit: 250, fade: 150 } as const;

/** The easing to hand `element.animate`, with the cubic-bezier where `linear()` is missing. */
export function sheetEasing(): string {
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    try {
      if (CSS.supports("animation-timing-function", "linear(0, 1)")) return MOTION_SPRING.sheet;
    } catch {
      // fall through
    }
  }
  return MOTION_SPRING.sheetFallback;
}
