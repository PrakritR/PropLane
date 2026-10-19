import localFont from "next/font/local";

/** Same Bricolage face at the homepage's existing weight/width; all glyphs and optical sizing retained. */
export const homeDisplayFont = localFont({
  src: "./BricolageGrotesque-home.woff2",
  variable: "--font-home-display",
  weight: "600",
  style: "normal",
  display: "swap",
  preload: false,
  fallback: ["Schibsted Grotesk", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});

/** Generated from HOME_HEADLINE; regenerate alongside any headline edit. */
export const homeHeadlineFont = localFont({
  src: "./BricolageGrotesque-headline.woff2",
  variable: "--font-home-headline",
  weight: "600",
  style: "normal",
  display: "swap",
  preload: true,
  fallback: ["Schibsted Grotesk", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});
