"use client";

import { AxisAssistantChatIcon } from "@/components/portal/assistant-shared";
import { useHasAxisAssistant } from "@/components/portal/axis-assistant";
import { track } from "@/lib/analytics/track-client";
import { openAxisAssistant } from "@/lib/axis-assistant/open-store";

/**
 * Desktop entry to the resident assistant on the dashboard: a compact card that opens the side panel. Phones have the
 * Ask tab in the bottom bar instead, so this is `lg` and up only. Draws nothing where no assistant is mounted (demo).
 */
export function ResidentAskCard() {
  const hasAssistant = useHasAxisAssistant();
  if (!hasAssistant) return null;
  return (
    <button
      type="button"
      data-attr="resident-dashboard-ask"
      onClick={() => {
        track("assistant_opened");
        openAxisAssistant();
      }}
      className="hidden w-full items-center gap-2.5 rounded-[10px] border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 lg:flex"
    >
      <AxisAssistantChatIcon className="h-5 w-5 shrink-0 text-primary" />
      <span className="text-sm font-semibold text-foreground">Ask PropLane</span>
      <span aria-hidden className="text-primary">›</span>
    </button>
  );
}
