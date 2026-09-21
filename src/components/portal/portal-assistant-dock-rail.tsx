"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { useAxisAssistantDock } from "@/components/portal/axis-assistant";
import { openAxisAssistant } from "@/lib/axis-assistant/open-store";
import {
  collapseAssistantDock,
  getAssistantDockCollapsed,
  getAssistantDocked,
  initAssistantDockState,
  subscribeAssistantDockCollapsed,
  toggleAssistantDock,
} from "@/lib/axis-assistant/dock-store";

/**
 * Full-height right-side assistant rail for the manager portal shell.
 *
 * Renders NOTHING unless the manager explicitly switched the assistant into
 * docked mode (`popup` is the default) and this portal opted in via
 * `<AxisAssistant dockable>`. Mounted as the last flex child of the portal
 * shell's `lg:flex-row`, so when it is on it pins to the right edge and spans
 * the full height beside every section — not just the dashboard — while the
 * content column keeps the reclaimed width whenever it is off. Collapsing
 * the rail also returns that width: the expand control lives in the portal
 * top bar, so this aside must not reserve a leftover strip.
 *
 * `hidden lg:flex`: below `lg` there is no room for a rail, so the FAB/popup
 * stays the assistant regardless of the saved mode.
 */
export function PortalAssistantDockRail({
  managerName,
  initialCollapsed = true,
}: {
  managerName?: string | null;
  initialCollapsed?: boolean;
}) {
  const { dockable, mode, setMode } = useAxisAssistantDock();
  const collapsed = useSyncExternalStore(
    subscribeAssistantDockCollapsed,
    getAssistantDockCollapsed,
    () => initialCollapsed,
  );

  useEffect(() => {
    initAssistantDockState({ collapsed: initialCollapsed, docked: getAssistantDocked() });
  }, [initialCollapsed]);

  const undockToPopup = useCallback(() => {
    setMode("popup");
    collapseAssistantDock();
    openAxisAssistant();
  }, [setMode]);

  if (!dockable || mode !== "docked" || collapsed) return null;

  return (
    <aside
      className="portal-assistant-dock-rail relative hidden h-full min-h-0 w-[var(--portal-assistant-rail-width)] shrink-0 self-stretch flex-col overflow-hidden border-l border-border/70 bg-background p-3 lg:flex"
      aria-label="PropLane Assistant"
      data-attr="portal-assistant-dock-rail"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-attr="dashboard-assistant-dock">
        <AssistantDockPanel
          managerName={managerName}
          onCollapse={toggleAssistantDock}
          onClose={undockToPopup}
          inputId={ASSISTANT_DOCK_INPUT_ID}
          className="h-full"
        />
      </div>
    </aside>
  );
}
