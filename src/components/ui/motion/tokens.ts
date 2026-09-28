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
  cell: "cubic-bezier(0.34, 1.4, 0.64, 1)",
  crossfade: "cubic-bezier(0.22, 1, 0.36, 1)",
  nudge: "cubic-bezier(0.3, 1.6, 0.7, 1)",
  fill: "cubic-bezier(0.16, 0.8, 0.3, 1)",
  disclose: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;
