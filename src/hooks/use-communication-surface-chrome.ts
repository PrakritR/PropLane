"use client";

import { useLayoutEffect } from "react";

/**
 * Communication surfaces (main tab + resident-detail chat) apply their
 * communication-specific layout. `threadReading` adds the full-bleed mobile
 * thread layout (no extra page chrome). `threadSelected` hides the assistant
 * whenever a conversation is active (desktop split or mobile).
 */
export function useCommunicationSurfaceChrome({
  active,
  threadReading = false,
  threadSelected = false,
  /** Hides the floating assistant FAB for the whole Communication tab (e.g. resident mobile). */
  hideAssistantFab = false,
}: {
  active: boolean;
  threadReading?: boolean;
  threadSelected?: boolean;
  hideAssistantFab?: boolean;
}) {
  useLayoutEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    html.dataset.communicationSurface = "true";
    if (threadReading) {
      html.dataset.communicationThreadReading = "true";
    } else {
      delete html.dataset.communicationThreadReading;
    }
    if (threadSelected) {
      html.dataset.communicationThreadSelected = "true";
    } else {
      delete html.dataset.communicationThreadSelected;
    }
    if (hideAssistantFab) {
      html.dataset.communicationHideAssistantFab = "true";
      html.dataset.hideAssistantFab = "true";
    } else {
      delete html.dataset.communicationHideAssistantFab;
      delete html.dataset.hideAssistantFab;
    }
    return () => {
      delete html.dataset.communicationSurface;
      delete html.dataset.communicationThreadReading;
      delete html.dataset.communicationThreadSelected;
      delete html.dataset.communicationHideAssistantFab;
      delete html.dataset.hideAssistantFab;
    };
  }, [active, hideAssistantFab, threadReading, threadSelected]);
}
