"use client";

import dynamic from "next/dynamic";

/**
 * The public-page assistant (and its markdown renderer) loads after the page,
 * as its own chunk. It renders nothing until the client mounts anyway
 * (`useIsClient`), so skipping SSR changes no markup.
 */
export const GeneralAssistantLazy = dynamic(
  () => import("@/components/general/general-assistant").then((m) => m.GeneralAssistant),
  { ssr: false },
);
