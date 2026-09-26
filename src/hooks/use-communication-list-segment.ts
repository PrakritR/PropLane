"use client";

import { useEffect, useState } from "react";
import { parseCommunicationListSegment } from "@/lib/portal-communication-nav";

export type CommunicationListSegmentValue = "active" | "unread" | "archived";

/**
 * Client-tracked Active/Unread/Archived segment for Communication — mirrors
 * `useCommunicationThreadId`'s shape. Initialized from the server-resolved
 * route prop, then owned by client state so a plain-click tab switch
 * (`InboxListSegmentTabs` with `interceptNavigation`) can update it via
 * `setSegment` and a `history.pushState` (PLAN B1) without a full App Router
 * navigation — which is what remounted `ManagerUnifiedInbox` and reset its
 * loaded lists on every tab click. Browser back/forward still updates the
 * segment via `popstate`.
 */
export function useCommunicationListSegment(
  commBase: string,
  initialSegment: CommunicationListSegmentValue,
) {
  const [segment, setSegment] = useState<CommunicationListSegmentValue>(initialSegment);

  useEffect(() => {
    setSegment(initialSegment);
  }, [initialSegment]);

  useEffect(() => {
    const syncFromPath = () => {
      const next = parseCommunicationListSegment(window.location.pathname, commBase);
      if (next) setSegment(next);
    };
    window.addEventListener("popstate", syncFromPath);
    return () => window.removeEventListener("popstate", syncFromPath);
  }, [commBase]);

  return { segment, setSegment };
}
