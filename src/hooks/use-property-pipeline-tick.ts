"use client";

import { useEffect, useState } from "react";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";

/**
 * Bumps whenever the browser's property store changes (server sync landed, a form was saved). The
 * store is a read-through cache, so a view that derives from it re-reads on this tick instead of
 * freezing whatever it saw on its first render.
 */
export function usePropertyPipelineTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, bump);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, bump);
  }, []);
  return tick;
}
