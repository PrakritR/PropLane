"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import { track } from "@/lib/analytics/track-client";
import {
  collapseAssistantDock,
  getAssistantDockCollapsed,
  subscribeAssistantDockCollapsed,
} from "@/lib/axis-assistant/dock-store";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  openAxisAssistant,
  sendAxisAssistantPrompt,
  subscribeAxisAssistantOpen,
} from "@/lib/axis-assistant/open-store";

/**
 * The one way a portal opens its assistant, shared by the top strip's panel
 * button, the phone top bar's sparkle button, the command palette's "Ask
 * PropLane" row and the composer's "Ask PropLane".
 *
 * There is one assistant window: the side panel on `lg` and up, a full-screen
 * sheet below. `openAxisAssistant()` / `sendAxisAssistantPrompt()` pick the
 * right one, and nothing here knows which role it is mounted for - the
 * surrounding `<AxisAssistant>` provider (manager, resident or vendor
 * endpoint) is the role-correct assistant, so every portal's launcher reaches
 * its own endpoint.
 */
export function useAssistantLauncher() {
  const isSmall = useIsSmallPortalViewport();
  const sheetOpen = useSyncExternalStore(subscribeAxisAssistantOpen, getAxisAssistantOpen, () => false);
  const panelCollapsed = useSyncExternalStore(subscribeAssistantDockCollapsed, getAssistantDockCollapsed, () => true);
  // Whichever surface this viewport uses is the one that counts as "open".
  const assistantOpen = isSmall ? sheetOpen : !panelCollapsed;

  const open = useCallback(() => {
    track("assistant_opened");
    openAxisAssistant();
  }, []);

  const toggle = useCallback(() => {
    if (isSmall) {
      if (getAxisAssistantOpen()) closeAxisAssistant();
      else open();
      return;
    }
    if (!getAssistantDockCollapsed()) {
      collapseAssistantDock();
      return;
    }
    open();
  }, [isSmall, open]);

  /**
   * Open the assistant and, when the user typed a question, send it. The
   * prompt channel opens the right surface and submits into the shared
   * conversation, so the side panel (or sheet) shows the answer.
   */
  const ask = useCallback(
    (query?: string) => {
      const text = query?.trim() ?? "";
      if (!text) {
        open();
        return;
      }
      track("assistant_opened");
      sendAxisAssistantPrompt(text);
    },
    [open],
  );

  return { assistantOpen, assistantVisible: assistantOpen, open, toggle, ask };
}
