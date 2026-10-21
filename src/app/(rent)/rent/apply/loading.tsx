import { ApplyLoadingCover } from "./apply-loading-cover";

/**
 * Without this, the frame that paints while the apply page resolves is the
 * generic public fallback — marketing navbar, footer and a hero-shaped skeleton.
 * For a signed-in resident that frame is the WRONG PAGE: they are about to be
 * handed to the portal, and watching the marketing site paint first and then
 * reload is what reads as the application link opening, going back, and opening
 * again. Same cover as the hand-off itself, so the two frames are identical.
 */
export default function ApplyLoading() {
  return <ApplyLoadingCover />;
}
