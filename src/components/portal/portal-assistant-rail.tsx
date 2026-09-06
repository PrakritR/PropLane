"use client";

import { ChevronsLeft } from "lucide-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import { openAxisAssistant } from "@/lib/axis-assistant/open-store";
import {
  getAssistantDockCollapsed,
  getAssistantDocked,
  initAssistantDockState,
  subscribeAssistantDockCollapsed,
  subscribeAssistantDocked,
  toggleAssistantDock,
  undockAssistantFromRail,
} from "@/lib/axis-assistant/dock-store";
import { cn } from "@/lib/utils";

function useAssistantDockState(initial: { collapsed: boolean; docked: boolean }) {
  const collapsed = useSyncExternalStore(
    subscribeAssistantDockCollapsed,
    getAssistantDockCollapsed,
    () => initial.collapsed,
  );
  const docked = useSyncExternalStore(subscribeAssistantDocked, getAssistantDocked, () => initial.docked);

  useEffect(() => {
    initAssistantDockState(initial);
  }, [initial.collapsed, initial.docked]);

  return { collapsed, docked };
}

/**
 * Desktop right rail — shown only after the user docks the popup assistant.
 * Collapses to a narrow icon column; hidden entirely until docked.
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

  const undockToPopup = useCallback(() => {
    undockAssistantFromRail();
    openAxisAssistant();
  }, []);

  if (isSmall || !docked) return null;

  return (
    <aside
      className={cn(
        "portal-assistant-rail relative z-30 hidden h-full min-h-0 shrink-0 self-stretch flex-col overflow-hidden border-l border-border bg-background lg:flex",
        collapsed ? "w-[58px]" : "w-[var(--portal-assistant-rail-width)]",
      )}
      data-attr="portal-assistant-rail"
      aria-label="PropLane Assistant"
    >
      {collapsed ? (
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
          <button
            type="button"
            onClick={toggleAssistantDock}
            aria-label="Expand PropLane Assistant"
            aria-expanded={false}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground"
          >
            <ChevronsLeft className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-2 pt-0">
          <AssistantDockPanel
            managerName={managerName}
            endpoint={endpoint}
            onCollapse={toggleAssistantDock}
            onUndockToPopup={undockToPopup}
            className="h-full"
          />
        </div>
      )}
    </aside>
  );
}
