import localFont from "next/font/local";

/** Inter Tight, OFL-licensed; self-hosted so the cover needs no third-party request. */
export const homeSwissFont = localFont({
  src: "./InterTight-variable.woff2",
  variable: "--font-home-swiss",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  fallback: ["Arial", "sans-serif"],
});

/** Tiny 600-weight cover subset keeps the main text independent of the full UI font. */
export const homeSwissCoverFont = localFont({
  src: "./InterTight-cover.woff2",
  variable: "--font-home-swiss-cover",
  weight: "600",
  style: "normal",
  display: "swap",
  preload: true,
  fallback: ["Arial", "sans-serif"],
});
