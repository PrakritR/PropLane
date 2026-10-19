"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/**
 * The public-page assistant (and its markdown renderer) loads after the page,
 * as its own chunk. It renders nothing until the client mounts anyway
 * (`useIsClient`), so skipping SSR changes no markup.
 */
const Assistant = dynamic(
  () => import("@/components/general/general-assistant").then((m) => m.GeneralAssistant),
  { ssr: false },
);

/** The homepage owns its fullscreen sandbox chat; do not load a second assistant. */
export function GeneralAssistantLazy() {
  const pathname = usePathname();
  return pathname === "/" ? null : <Assistant />;
}
