/**
 * PropLane's typeface.
 *
 * The product previously had NO webfont: `--font-sans` was a system stack, so
 * it rendered as SF Pro on a Mac, Segoe UI on Windows and Roboto on Android —
 * three different products, and no typographic identity anywhere.
 *
 * Schibsted Grotesk (SIL Open Font License) is a Swiss neo-grotesque whose
 * variable axis is 400–900, exactly the weight range this codebase uses. It
 * was chosen over Inter and Geist because both read as framework defaults, and
 * over Switzer/General Sans because the Fontshare licence is not OFL and
 * restricts redistributing the file in a repository.
 *
 * NON-NEGOTIABLE: it must keep real tabular figures. `tabular-nums` appears
 * 133 times across 46 files — every payment ledger, rent table and KPI tile —
 * and a face without a `tnum` feature makes that CSS a SILENT no-op, ragging
 * every money column with nothing failing anywhere. The committed subset is
 * verified to retain `tnum` (and `zero`, `case`, `frac`); re-verify with
 * fontTools before ever replacing this file.
 *
 * Self-hosted rather than fetched from Google so the iOS Capacitor shell,
 * which loads the deployed site in a WebView, does not open a third-party
 * connection on every cold start.
 */
import localFont from "next/font/local";

export const brandSans = localFont({
  src: "./fonts/schibsted-grotesk-variable.woff2",
  // A PRIVATE variable, deliberately not `--font-sans`. Tailwind v4 emits
  // `--font-sans` from its own `@theme inline` block on `:root`, and next/font
  // sets its variable via a class on <html>; naming both the same makes the two
  // definitions collide, and the loser is not obvious. globals.css composes
  // this one INTO `--font-sans` instead, which is unambiguous.
  variable: "--font-brand-sans",
  weight: "400 900",
  style: "normal",
  display: "swap",
  preload: true,
  // The stack that used to BE the product, kept as the fallback so a failed
  // font load degrades to exactly today's rendering rather than to Times.
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "SF Pro Display",
    "SF Pro Text",
    "Helvetica Neue",
    "ui-sans-serif",
    "system-ui",
    "sans-serif",
  ],
  adjustFontFallback: "Arial",
});
