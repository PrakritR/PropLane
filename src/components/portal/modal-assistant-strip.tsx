"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { AxisAssistantSparkleIcon } from "@/components/portal/assistant-shared";
import { AssistantConversationProvider } from "@/lib/axis-assistant/assistant-conversation-context";
import { modalAssistantStorageScope } from "@/lib/axis-assistant/assistant-chat-storage";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { cn } from "@/lib/utils";

export type ModalAssistantStripProps = {
  contextHint?: string | null;
  /** Shown beside the assistant label — e.g. "Type in chat to edit lease". */
  editHint?: string | null;
  /**
   * Stable scope key for this modal surface (e.g. "New promotion"), without step
   * labels. Defaults to contextHint.
   */
  storageScopeKey?: string | null;
  /**
   * Bumped when the modal opens so each visit starts a fresh thread (saved under
   * its own scope). Main popup/dock history is unchanged.
   */
  conversationInstance?: number;
  className?: string;
  /**
   * Reports open/closed changes so an ancestor can lay out a side-by-side panel
   * (content + chat) while this strip is open. Purely informational — this
   * component still owns the expand/collapse state itself.
   */
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Which side the expanded chat docks to once the container is wide enough
   * (the `@2xl` breakpoint). Defaults to `"right"` — the shared-`Modal` layout —
   * so only surfaces that opt in (the listing wizard) move it left.
   */
  side?: "left" | "right";
  /**
   * Initial expanded state, re-applied whenever a new `conversationInstance`
   * starts. Defaults to `false` (collapsed) so the general portal modals keep
   * the field area free until a manager asks for help; a surface can pass
   * `true` (e.g. on desktop widths) to open the assistant beside the form.
   */
  defaultExpanded?: boolean;
  /** When true, the assistant stays open with no hide/expand toggle. */
  alwaysExpanded?: boolean;
  /** Let the chat panel grow to fill the modal body (lease edit full-screen mobile). */
  fillHeight?: boolean;
};

/**
 * Compact assistant input strip for portal modals — scoped to the modal title
 * so the agent knows what surface the manager is working in.
 *
 * Collapsed by default so form fields keep the full scroll area; managers expand
 * when they want help. Once open, it renders as a side panel (chat to the right
 * of the modal content) whenever the surrounding container is wide enough —
 * see the `@2xl` container-query breakpoint below — and otherwise stays a
 * stacked band beneath the content, matching the pre-existing collapsed layout.
 */
export function ModalAssistantStrip({
  contextHint,
  editHint,
  storageScopeKey,
  conversationInstance = 0,
  className,
  onExpandedChange,
  side = "right",
  defaultExpanded = false,
  alwaysExpanded = false,
  fillHeight = false,
}: ModalAssistantStripProps) {
  const config = usePortalAssistantConfig();
  const [expanded, setExpanded] = useState(alwaysExpanded || defaultExpanded);
  const showExpanded = alwaysExpanded || expanded;

  const toggle = (next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(next);
  };

  useEffect(() => {
    setExpanded(alwaysExpanded || defaultExpanded);
    onExpandedChange?.(alwaysExpanded || defaultExpanded);
    // onExpandedChange + defaultExpanded intentionally excluded: callers commonly
    // pass a fresh inline setter each render, and this reset should only fire when
    // a new conversation instance starts (a fresh modal open), not on every parent
    // re-render — it re-reads defaultExpanded at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationInstance]);

  if (!config) return null;

  const scopeSource = (storageScopeKey ?? contextHint ?? "Portal modal").trim();
  const storageScope = modalAssistantStorageScope(scopeSource, conversationInstance);

  return (
    <AssistantConversationProvider endpoint={config.endpoint} storageScope={storageScope}>
      <div
        className={cn(
          "flex min-w-0 flex-col border-t border-border bg-transparent",
          fillHeight && showExpanded ? "min-h-0 flex-1" : "shrink-0",
          showExpanded && "@2xl:min-h-0 @2xl:w-80 @2xl:shrink-0 @2xl:border-t-0",
          showExpanded && (side === "left" ? "@2xl:border-r" : "@2xl:border-l"),
          className,
        )}
        data-attr="modal-assistant-strip"
        data-expanded={showExpanded ? "true" : "false"}
      >
        {showExpanded ? (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col px-0 pt-3 @2xl:pt-4",
              side === "left" ? "@2xl:pr-4" : "@2xl:pl-4",
            )}
          >
            <div className="mb-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-primary">
                  <AxisAssistantSparkleIcon className="h-4 w-4 shrink-0" />
                  PropLane Assistant
                </p>
                {alwaysExpanded ? null : (
                  <button
                    type="button"
                    onClick={() => toggle(false)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted transition hover:bg-foreground/5 hover:text-foreground"
                    data-attr="modal-assistant-collapse"
                    aria-expanded
                  >
                    Hide
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              {editHint?.trim() ? (
                <p className="text-xs text-muted">{editHint.trim()}</p>
              ) : null}
            </div>
            <AssistantDockPanel
              managerName={config.managerName}
              endpoint={config.endpoint}
              contextHint={contextHint}
              compact
              className={
                fillHeight
                  ? "min-h-0 flex-1 max-h-none"
                  : "max-h-[min(36vh,17rem)] @2xl:min-h-0 @2xl:max-h-none @2xl:flex-1"
              }
            />
          </div>
        ) : alwaysExpanded ? null : (
          <button
            type="button"
            onClick={() => toggle(true)}
            className="flex w-full flex-col gap-1.5 py-3 text-left text-sm transition hover:bg-foreground/[0.02]"
            data-attr="modal-assistant-expand"
            aria-expanded={false}
          >
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 font-semibold text-primary">
                <AxisAssistantSparkleIcon className="h-4 w-4 shrink-0" />
                Ask PropLane Assistant
              </span>
              <ChevronUp className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </span>
            {editHint?.trim() ? <span className="text-xs font-normal text-muted">{editHint.trim()}</span> : null}
          </button>
        )}
      </div>
    </AssistantConversationProvider>
  );
}
