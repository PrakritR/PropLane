"use client";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { RESIDENT_ASSISTANT_ENDPOINT } from "@/components/portal/assistant-panel-chrome";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";

/**
 * The thread pane of the pinned "PropLane" row in the resident's Communication list.
 *
 * It is the SAME conversation as the top bar's side panel (desktop) / full-screen sheet (phone), the dashboard's Ask
 * card and the phone's Ask tab: `AssistantDockPanel` reads the one provider the resident layout mounts
 * (`/api/agent/resident-chat`), so a message typed here is the history there, and the other way round. It never goes
 * through `send-inbox-message` and there is no second assistant route or registry.
 *
 * It deliberately passes no `inputId`: the portal's "Ask PropLane" focus hook belongs to the side panel.
 */
export function ResidentAssistantThread({ onClose }: { onClose?: () => void }) {
  const config = usePortalAssistantConfig();
  return (
    <AssistantDockPanel
      managerName={config?.managerName ?? null}
      endpoint={RESIDENT_ASSISTANT_ENDPOINT}
      onClose={onClose}
      className="h-full rounded-none border-0 bg-transparent"
      pinnedComposer
    />
  );
}
