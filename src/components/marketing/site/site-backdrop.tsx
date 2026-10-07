import "./site-display.css";
import { ResidentLifecycleAtmosphere } from "@/components/marketing/resident-lifecycle-atmosphere";

/**
 * The home hero's wavy-line and particle atmosphere, reusable by any public
 * page. It is the same component (and the same CSS) the home hero draws, not a
 * copy: `site-display.css` only changes how it is laid out inside a
 * `.site-page` (a viewport-high sticky layer) or an `.auth-layout` (it fills the
 * frame).
 *
 * It listens for the pointer on its parent element, so render it as a direct
 * child of the element that should react: `SitePage` and the auth layout do.
 */
export function SiteBackdrop() {
  return <ResidentLifecycleAtmosphere />;
}
