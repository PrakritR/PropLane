"use client";

import { useEffect, useSyncExternalStore } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import {
  focusAskPropLane,
  getAssistantDockCollapsed,
  getAssistantDocked,
  initAssistantDockState,
  subscribeAssistantDockCollapsed,
  subscribeAssistantDocked,
  undockAssistantFromRail,
} from "@/lib/axis-assistant/dock-store";

function useAssistantDockState(initial: { collapsed: boolean; docked: boolean }) {
  const collapsed = useSyncExternalStore(
    subscribeAssistantDockCollapsed,
    getAssistantDockCollapsed,
    () => initial.collapsed,
  );
  const docked = useSyncExternalStore(subscribeAssistantDocked, getAssistantDocked, () => initial.docked);

  const { collapsed: initialCollapsed, docked: initialDocked } = initial;
  useEffect(() => {
    initAssistantDockState({ collapsed: initialCollapsed, docked: initialDocked });
  }, [initialCollapsed, initialDocked]);

  return { collapsed, docked };
}

/**
 * Desktop right rail — shown only after the user docks the popup assistant.
 * Collapsing returns the full content width; the expand control lives in the
 * portal top bar instead of a leftover strip. These portals (admin, vendor)
 * have no Settings display toggle, so the header ✕ leaves rail mode entirely
 * rather than only folding it; it never opens the popup in its place.
 */
export function PortalAssistantRail({
  managerName,
  endpoint = "/api/agent/chat",
  initialCollapsed = true,
  initialDocked = false,
}: {
  managerName?: string | null;
  endpoint?: string;
  initialCollapsed?: boolean;
  initialDocked?: boolean;
}) {
  const isSmall = useIsSmallPortalViewport();
  const { collapsed, docked } = useAssistantDockState({
    collapsed: initialCollapsed,
    docked: initialDocked,
  });

  if (isSmall || !docked || collapsed) return null;

  function closeRail() {
    undockAssistantFromRail();
    focusAskPropLane();
  }

  return (
    <aside
      className="portal-assistant-rail relative z-30 hidden h-full min-h-0 w-[var(--portal-assistant-rail-width)] shrink-0 self-stretch flex-col overflow-hidden border-l border-border bg-background lg:flex"
      data-attr="portal-assistant-rail"
      aria-label="PropLane Assistant"
    >
      <div className="flex min-h-0 flex-1 flex-col p-2 pt-0">
        <AssistantDockPanel
          managerName={managerName}
          endpoint={endpoint}
          onClose={closeRail}
          className="h-full"
        />
      </div>
    </aside>
  );
}
