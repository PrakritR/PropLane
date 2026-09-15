"use client";

import { useCallback, useId, useRef, type KeyboardEvent } from "react";

import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAxisAssistantDock } from "@/components/portal/axis-assistant";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { AssistantDisplayMode } from "@/lib/assistant-display-preferences";
import { cn } from "@/lib/utils";

const OPTIONS: { mode: AssistantDisplayMode; label: string; description: string }[] = [
  {
    mode: "popup",
    label: "Floating popup",
    description: "Ask PropLane in the header opens the assistant over your work.",
  },
  {
    mode: "docked",
    label: "Pinned to the right",
    description: "A full-height panel stays open beside the portal on wide screens.",
  },
];

/**
 * Settings entry point for the assistant display mode, on the manager Settings
 * page. It writes the SAME persisted preference as the in-assistant pin and the
 * rail's unpin (`useAxisAssistantDock` / `assistant-display-preferences.ts`).
 */
export function AssistantDisplaySetting() {
  const { dockable, mode, setMode } = useAxisAssistantDock();
  const isSmall = useIsSmallPortalViewport();
  const groupId = useId();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step === 0) return;
      event.preventDefault();

      const current = optionRefs.current.findIndex((node) => node === document.activeElement);
      const from = current === -1 ? OPTIONS.findIndex((option) => option.mode === mode) : current;
      const next = (from + step + OPTIONS.length) % OPTIONS.length;
      setMode(OPTIONS[next]!.mode);
      optionRefs.current[next]?.focus();
    },
    [mode, setMode],
  );

  if (isDemoModeActive() || !dockable) return null;

  return (
    <PortalSettingsSection
      title="PropLane Assistant"
    >
      <PortalSettingsGroup>
        <PortalSettingsRow
          className="flex-col items-start gap-3 sm:flex-row sm:items-center"
          label="Display"
        >
          <div
            role="radiogroup"
            aria-label="Assistant display"
            onKeyDown={onKeyDown}
            className="flex flex-col gap-2 sm:flex-row"
          >
            {OPTIONS.map((option, index) => {
              const selected = mode === option.mode;
              const labelId = `${groupId}-${index}-label`;
              const descriptionId = `${groupId}-${index}-description`;
              return (
                <button
                  key={option.label}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setMode(option.mode)}
                  data-attr={`assistant-display-${option.mode === "docked" ? "docked" : "popup"}`}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/25 sm:max-w-[15rem]",
                    selected
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:border-primary/30",
                  )}
                >
                  <span
                    id={labelId}
                    className={cn(
                      "block text-sm font-medium",
                      selected ? "text-foreground" : "text-muted",
                    )}
                  >
                    {option.label}
                  </span>
                  <span id={descriptionId} className="mt-0.5 block text-xs leading-relaxed text-muted">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
        </PortalSettingsRow>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
