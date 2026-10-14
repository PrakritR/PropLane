"use client";

import { useEffect, useState } from "react";

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
 * The aside stays mounted so opening is a motion, not a pop: its width eases
 * between 0 and the rail width (the content column beside it reflows with it)
 * while the panel inside keeps its full width and is simply revealed. Closed, it
 * is `inert` and `aria-hidden`. The panel itself mounts the first time the rail
 * opens, so a rail nobody opens costs nothing. Reduced motion cross-fades.
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

  // The panel mounts on first open and stays, so closing can slide it away with its content.
  const [hasOpened, setHasOpened] = useState(!collapsed);
  if (!collapsed && !hasOpened) setHasOpened(true);

  if (isSmall) return null;

  function closeRail() {
    collapseAssistantDock();
    focusAskPropLane();
  }

  return (
    <aside
      className="portal-assistant-rail relative z-30 hidden h-full min-h-0 shrink-0 self-stretch flex-col overflow-hidden bg-card text-foreground transition-[width,opacity] duration-(--spring-gentle-duration) ease-(--spring-gentle) data-[open=false]:opacity-0 lg:flex"
      style={{ width: collapsed ? 0 : "var(--portal-assistant-rail-width)" }}
      data-attr="portal-assistant-rail"
      data-open={collapsed ? "false" : "true"}
      aria-label="PropLane Assistant"
      aria-hidden={collapsed || undefined}
      inert={collapsed || undefined}
    >
      <div
        className="flex h-full min-h-0 w-[var(--portal-assistant-rail-width)] shrink-0 flex-col border-l border-border"
        data-attr="dashboard-assistant-dock"
      >
        {hasOpened ? (
          <AssistantDockPanel
            managerName={managerName}
            endpoint={endpoint}
            onClose={closeRail}
            inputId={ASSISTANT_DOCK_INPUT_ID}
            className="h-full rounded-none border-0 bg-transparent"
          />
        ) : null}
      </div>
    </aside>
  );
}
