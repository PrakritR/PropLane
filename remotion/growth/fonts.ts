import { continueRender, delayRender, staticFile } from "remotion";

export const FONT_FAMILY = "Schibsted Grotesk";

let started = false;

/** Load the repo's variable font (copied to public/fonts) before the first frame is captured. */
export function loadBrandFont(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  const handle = delayRender("Loading Schibsted Grotesk");
  const face = new FontFace(FONT_FAMILY, `url(${staticFile("fonts/schibsted-grotesk-variable.woff2")}) format("woff2")`, {
    weight: "400 900",
  });
  face
    .load()
    .then((f) => {
      document.fonts.add(f);
    })
    .catch(() => undefined)
    .finally(() => continueRender(handle));
}
