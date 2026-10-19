"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isJourneyPath } from "@/components/public-site/journey-paths";

/**
 * Picks the prospect journey's chrome (the approved homepage's bar and footer) on journey paths and the
 * older public chrome everywhere else. Both arrive as server-rendered children.
 */
export function JourneyChromeSwitch({ journey, children }: { journey: ReactNode; children: ReactNode }) {
  return isJourneyPath(usePathname()) ? journey : children;
}
