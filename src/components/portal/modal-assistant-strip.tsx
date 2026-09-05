"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { AxisAssistantSparkleIcon } from "@/components/portal/assistant-shared";
import { AssistantConversationProvider } from "@/lib/axis-assistant/assistant-conversation-context";
import { modalAssistantStorageScope } from "@/lib/axis-assistant/assistant-chat-storage";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { cn } from "@/lib/utils";
import { useVisualViewportBottomInset } from "@/hooks/use-visual-viewport-bottom-inset";

let openModalAssistants = 0;

export type ModalAssistantStripProps = {
  contextHint?: string | null;
  /** Shared dialog header slot; custom editors keep the compact trigger in place. */
  triggerTarget?: HTMLElement | null;
  hideTrigger?: boolean;
  detached?: boolean;
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
   * @deprecated The shared assistant always opens at the right viewport rail.
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

/** Compact editor CTA and right-side assistant, within the editor’s focus boundary. */
export function ModalAssistantStrip({
  contextHint,
  editHint,
  storageScopeKey,
  conversationInstance = 0,
  className,
  onExpandedChange,
  triggerTarget,
  hideTrigger = false,
  detached = false,
  defaultExpanded = false,
  alwaysExpanded = false,
}: ModalAssistantStripProps) {
  const config = usePortalAssistantConfig();
  const [expanded, setExpanded] = useState(alwaysExpanded || defaultExpanded);
  const showExpanded = expanded;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [railTarget, setRailTarget] = useState<HTMLElement | null>(null);
  const railId = useId();
  const focusRail = useCallback((node: HTMLElement | null) => {
    node?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const keyboardInset = useVisualViewportBottomInset(showExpanded);

  const toggle = (next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(next);
    if (!next) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new editor visit resets its local presentation
    setExpanded(alwaysExpanded || defaultExpanded);
    onExpandedChange?.(alwaysExpanded || defaultExpanded);
    // Reset only for a fresh editor visit, not each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationInstance]);

  useEffect(() => {
    const target = anchorRef.current?.closest<HTMLElement>('[role="dialog"]');
    setRailTarget(target ?? null);
  }, []);

  useEffect(() => {
    if (!showExpanded) return;
    railTarget?.setAttribute("data-modal-assistant-open", "");
    openModalAssistants += 1;
    document.documentElement.setAttribute("data-modal-assistant-active", "");
    return () => {
      railTarget?.removeAttribute("data-modal-assistant-open");
      openModalAssistants -= 1;
      if (openModalAssistants === 0) document.documentElement.removeAttribute("data-modal-assistant-active");
    };
  }, [showExpanded, railTarget]);

  if (!config) return null;
  const scopeSource = (storageScopeKey ?? contextHint ?? "Portal modal").trim();
  const storageScope = modalAssistantStorageScope(scopeSource, conversationInstance);
  const trigger = !hideTrigger ? (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => toggle(!showExpanded)}
      className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-primary/25 px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-attr="modal-assistant-expand"
      aria-expanded={showExpanded}
      aria-controls={showExpanded ? railId : undefined}
    >
      <AxisAssistantSparkleIcon className="h-4 w-4 shrink-0" />
      Ask PropLane
    </button>
  ) : null;
  const rail = showExpanded ? (
    <aside
      ref={focusRail}
      id={railId}
      aria-label="PropLane Assistant"
      style={{ bottom: keyboardInset }}
      data-attr="modal-assistant-rail"
      className="pointer-events-auto fixed inset-y-0 right-0 z-[72] flex w-full min-w-0 flex-col border-l border-border bg-background p-4 pt-[max(1rem,var(--native-safe-top,0px))] pb-[max(1rem,var(--native-safe-bottom,0px))] md:w-[var(--portal-assistant-rail-width)]"
    >
      {detached ? <p className="mb-3 text-sm text-muted" role="status">Editor closed. Start a new conversation below.</p> : null}
      <AssistantDockPanel
        managerName={config.managerName}
        endpoint={config.endpoint}
        contextHint={contextHint}
        compact
        pinnedComposer
        onCollapse={() => toggle(false)}
        composerHint={editHint?.trim() || "How can I help?"}
        className="min-h-0 flex-1 max-h-none"
      />
    </aside>
  ) : null;
  return (
    <AssistantConversationProvider endpoint={config.endpoint} storageScope={storageScope}>
      <span ref={anchorRef} className={cn("shrink-0", className)} data-attr="modal-assistant-strip" data-expanded={showExpanded}>
        {triggerTarget ? createPortal(trigger, triggerTarget) : trigger}
        {railTarget ? createPortal(rail, railTarget) : rail}
      </span>
    </AssistantConversationProvider>
  );
}
