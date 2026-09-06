"use client";

import { ChevronsLeft } from "lucide-react";
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
import { cn } from "@/lib/utils";

/**
 * Full-height right-side assistant rail for the manager portal shell.
 *
 * Renders NOTHING unless the manager explicitly switched the assistant into
 * docked mode (`popup` is the default) and this portal opted in via
 * `<AxisAssistant dockable>`. Mounted as the last flex child of the portal
 * shell's `lg:flex-row`, so when it is on it pins to the right edge and spans
 * the full height beside every section — not just the dashboard — while the
 * content column keeps the reclaimed width whenever it is off.
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

  if (!dockable || mode !== "docked") return null;

  return (
    <aside
      className={cn(
        "portal-assistant-dock-rail relative hidden h-full min-h-0 shrink-0 self-stretch flex-col overflow-hidden border-l border-border/70 bg-background lg:flex",
        collapsed ? "w-[58px]" : "w-[var(--portal-assistant-rail-width)] p-3",
      )}
      aria-label="PropLane Assistant"
      data-attr="portal-assistant-dock-rail"
    >
      {collapsed ? (
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
          <button
            type="button"
            onClick={toggleAssistantDock}
            aria-label="Expand PropLane Assistant"
            aria-expanded={false}
            data-attr="portal-assistant-dock-expand"
            className="grid h-8 w-8 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground"
          >
            <ChevronsLeft className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" data-attr="dashboard-assistant-dock">
          <AssistantDockPanel
            managerName={managerName}
            onCollapse={toggleAssistantDock}
            onUndockToPopup={undockToPopup}
            inputId={ASSISTANT_DOCK_INPUT_ID}
            className="h-full"
          />
        </div>
      )}
    </aside>
  );
}
