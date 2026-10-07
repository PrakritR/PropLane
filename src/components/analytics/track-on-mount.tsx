"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics/track-client";

/**
 * Fires one funnel event when a server-rendered page loads. Renders nothing. `skipWhenEmbedded`
 * keeps a page that another page frames (the home hero's /demo) from counting every host view.
 */
export function TrackOnMount({
  event,
  properties,
  skipWhenEmbedded = false,
}: {
  event: string;
  properties?: Record<string, string | number | boolean | undefined>;
  skipWhenEmbedded?: boolean;
}) {
  useEffect(() => {
    try {
      if (skipWhenEmbedded && window.self !== window.top) return;
    } catch {
      return;
    }
    track(event, properties);
    // One event per mount: the inputs are static page constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
