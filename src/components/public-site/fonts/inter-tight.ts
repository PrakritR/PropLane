import localFont from "next/font/local";

/**
 * Inter Tight (SIL OFL, `OFL.txt` beside it), the face of the approved homepage (concept A, Oct 18 2026).
 * Self-hosted like `src/app/fonts.ts` so the native shell never opens a third-party connection.
 * The public pages read `--font-public-site`; the portals load the same file as `--font-brand-sans` (`src/app/fonts.ts`).
 */
export const publicSiteFont = localFont({
  src: "./inter-tight-variable.woff2",
  variable: "--font-public-site",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  fallback: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});
