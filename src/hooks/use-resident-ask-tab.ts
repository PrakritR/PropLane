"use client";

import { useHasAxisAssistant } from "@/components/portal/axis-assistant";
import { useAssistantLauncher } from "@/components/portal/use-assistant-launcher";
import { useResidentAssistantUnread } from "@/hooks/use-resident-assistant-unread";
import type { PortalDefinition } from "@/lib/portal-types";

/**
 * The resident phone bar's Ask tab state: shown only for a resident portal with the assistant mounted, and opening the one
 * assistant window (`useAssistantLauncher`). Every other portal gets `show: false` and nothing else changes.
 */
export function useResidentAskTab(kind: PortalDefinition["kind"]) {
  const hasAssistant = useHasAxisAssistant();
  const launcher = useAssistantLauncher();
  const show = kind === "resident" && hasAssistant;
  const unread = useResidentAssistantUnread(show);
  return { show, open: launcher.assistantOpen, unread, toggle: launcher.toggle };
}
