/**
 * The public site's display face: Bricolage Grotesque (Akhil's font, the one
 * the home hero headline is set in). Headings only; body text stays Schibsted
 * Grotesk (`brandSans`, `src/app/fonts.ts`).
 *
 * One definition, one CSS variable (`--font-site-display`). The class that
 * carries the variable goes on the public layout and the auth layout, and
 * `site-display.css` reads it, so every public H1 and H2 sets in this face.
 */
import localFont from "next/font/local";

export const siteDisplayFont = localFont({
  src: "./BricolageGrotesque-variable.woff2",
  variable: "--font-site-display",
  weight: "200 800",
  style: "normal",
  display: "swap",
  preload: true,
  fallback: ["Schibsted Grotesk", "-apple-system", "BlinkMacSystemFont", "Helvetica Neue", "ui-sans-serif", "system-ui", "sans-serif"],
  adjustFontFallback: "Arial",
});
