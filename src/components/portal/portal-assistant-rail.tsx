"use client";

import { useEffect } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import {
  collapseAssistantDock,
  focusAskPropLane,
  initAssistantDockState,
  useAssistantDockCollapsed,
} from "@/lib/axis-assistant/dock-store";

/**
 * The assistant's side panel: a full-height right rail beside the portal
 * content, mounted by every portal layout (manager, vendor, admin, resident).
 * It is the assistant on desktop (`lg` and up). Below `lg` there is no room
 * for it, and the top bar's sparkle button opens the full-screen sheet instead.
 *
 * Closed by default; the top bar's panel button, the command palette's Ask row
 * and the composer's "Ask PropLane" open it. Open/closed is remembered per
 * device (`dock-store`). Collapsing returns the full content width, so this
 * aside never reserves a leftover strip.
 *
 * `endpoint` MUST be the portal's own role-scoped chat route; it only selects
 * role-shaped copy here, while the surrounding `<AxisAssistant>` provider owns
 * the actual conversation transport.
 */
export function PortalAssistantRail({
  managerName,
  endpoint = "/api/agent/chat",
  initialCollapsed = true,
}: {
  managerName?: string | null;
  endpoint?: string;
  initialCollapsed?: boolean;
}) {
  const isSmall = useIsSmallPortalViewport();
  const collapsed = useAssistantDockCollapsed(initialCollapsed);

  useEffect(() => {
    initAssistantDockState({ collapsed: initialCollapsed });
  }, [initialCollapsed]);

  if (isSmall || collapsed) return null;

  function closeRail() {
    collapseAssistantDock();
    focusAskPropLane();
  }

  return (
    <aside
      className="portal-assistant-rail relative z-30 hidden h-full min-h-0 w-[var(--portal-assistant-rail-width)] shrink-0 self-stretch flex-col overflow-hidden border-l border-border bg-white lg:flex dark:bg-background"
      data-attr="portal-assistant-rail"
      aria-label="PropLane Assistant"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-attr="dashboard-assistant-dock">
        <AssistantDockPanel
          managerName={managerName}
          endpoint={endpoint}
          onClose={closeRail}
          inputId={ASSISTANT_DOCK_INPUT_ID}
          className="h-full rounded-none border-0 bg-transparent"
        />
      </div>
    </aside>
  );
}
