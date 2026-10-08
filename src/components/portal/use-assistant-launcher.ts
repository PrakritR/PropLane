"use client";

import { startTransition, useCallback, useSyncExternalStore } from "react";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { useAxisAssistantDock } from "@/components/portal/axis-assistant";
import { track } from "@/lib/analytics/track-client";
import {
  useOptionalAssistantConversation,
  type AssistantConversationValue,
} from "@/lib/axis-assistant/assistant-conversation-context";
import {
  collapseAssistantDock,
  expandAssistantDock,
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

/** The shared conversation, or null where no provider is mounted (tests, the public site). */
function useConversationIfMounted(): AssistantConversationValue | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a context read, safe to wrap
    return useOptionalAssistantConversation();
  } catch {
    return null;
  }
}

/**
 * The one way a portal opens its assistant, shared by the top strip's launcher,
 * its right-hand panel button and the command palette's "Ask PropLane" row.
 *
 * It is the behaviour the old top-bar "Ask PropLane" pill had, unchanged: a
 * docked, expanded rail counts as open (so the control toggles it closed like
 * the popup), the saved dock preference decides popup vs rail, and nothing
 * here knows which role it is mounted for - the surrounding `<AxisAssistant>`
 * provider (manager, resident or vendor endpoint) is the role-correct
 * assistant, so every portal's launcher reaches its own endpoint.
 */
export function useAssistantLauncher() {
  const conversation = useConversationIfMounted();
  const assistantOpen = useSyncExternalStore(subscribeAxisAssistantOpen, getAxisAssistantOpen, () => false);
  const { dockable, mode } = useAxisAssistantDock();
  const dockCollapsed = useSyncExternalStore(subscribeAssistantDockCollapsed, getAssistantDockCollapsed, () => true);
  // A docked, expanded rail counts as "open" so the one button toggles it closed.
  const dockRailOpen = dockable && mode === "docked" && !dockCollapsed;
  const assistantVisible = assistantOpen || dockRailOpen;

  const open = useCallback(() => {
    track("assistant_opened");

    const dockInput = document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null;
    if (dockInput?.offsetParent) {
      dockInput.focus();
      return;
    }

    // The rail is `lg`-only and only takes over when the SAVED preference says
    // "docked"; Ask PropLane opens whatever the user last chose.
    if (dockable && mode === "docked" && window.matchMedia?.("(min-width: 1024px)").matches) {
      expandAssistantDock();
      closeAxisAssistant();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          (document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null)?.focus();
        });
      });
      return;
    }

    startTransition(() => {
      openAxisAssistant();
    });
  }, [dockable, mode]);

  const toggle = useCallback(() => {
    const dockInput = document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null;
    if (assistantOpen) {
      closeAxisAssistant();
      return;
    }
    // An open rail closes like its X: the docked preference stays.
    if (dockInput?.offsetParent) {
      collapseAssistantDock();
      return;
    }
    open();
  }, [assistantOpen, open]);

  /**
   * Open the assistant and, when the user typed a question, send it. The popup
   * receives it through the shared prompt channel (which also opens it); a
   * docked rail is opened the normal way with the question in its composer.
   */
  const ask = useCallback(
    (query?: string) => {
      const text = query?.trim() ?? "";
      if (!text) {
        open();
        return;
      }
      const docked = dockable && mode === "docked" && window.matchMedia?.("(min-width: 1024px)").matches;
      if (docked) {
        // The rail is the visible surface: open it and hand it the question in
        // its own composer (the popup's prompt channel would also open the popup).
        open();
        conversation?.setInput(text);
        return;
      }
      track("assistant_opened");
      sendAxisAssistantPrompt(text);
    },
    [conversation, dockable, mode, open],
  );

  return { assistantOpen, assistantVisible, open, toggle, ask };
}
