"use client";

import { useEffect, useRef, useState } from "react";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantSmsTestControl } from "@/components/portal/assistant-sms-test-control";
import { AssistantChatHistoryPanel } from "@/components/portal/assistant-chat-history-panel";
import {
  AssistantEmptyState,
  AssistantMessageList,
  AssistantPanelHeader,
  MANAGER_ASSISTANT_ENDPOINT,
  RESIDENT_ASSISTANT_ENDPOINT,
  VENDOR_ASSISTANT_ENDPOINT,
} from "@/components/portal/assistant-panel-chrome";
import {
  AssistantPendingActionCard,
  AssistantResolvedActionFlash,
  RESIDENT_ASSISTANT_SUGGESTIONS,
  VENDOR_ASSISTANT_SUGGESTIONS,
} from "@/components/portal/assistant-shared";
import { useOptionalAssistantConversation } from "@/lib/axis-assistant/assistant-conversation-context";
import { visibleConversationMessages } from "@/lib/axis-assistant/use-assistant-conversation";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { cn } from "@/lib/utils";

export type AssistantDockPanelProps = {
  managerName?: string | null;
  endpoint?: string;
  /** Internal task context sent separately from visible user messages (e.g. modal title). */
  contextHint?: string | null;
  className?: string;
  /** Keep the composer pinned at the bottom; only message history scrolls. */
  pinnedComposer?: boolean;
  /** Replaces the empty-state subline when this surface has its own task framing. */
  composerHint?: string | null;
  /**
   * The header ✕. The desktop rails close themselves (the docked preference
   * stays, so Ask PropLane reopens the side view); a modal's rail is removed.
   */
  onClose?: () => void;
  /** Stable input hook for the portal header's Ask PropLane action. */
  inputId?: string;
};

/**
 * Shared PropLane Assistant conversation surface — used by the desktop right
 * rail, modal strips, and (legacy) dashboard embed. One conversation loop
 * (`useAssistantConversation`) everywhere; presentation only.
 */
export function AssistantDockPanel({
  managerName,
  endpoint = MANAGER_ASSISTANT_ENDPOINT,
  contextHint = null,
  className,
  pinnedComposer = false,
  composerHint = null,
  onClose,
  inputId,
}: AssistantDockPanelProps) {
  const {
    input,
    setInput,
    attachments,
    setAttachments,
    messages,
    ratings,
    submitFeedback,
    pendingAction,
    loading,
    error,
    setError,
    send,
    resolvePendingAction,
    reset,
    threads,
    activeThreadId,
    historyOpen,
    historyLoading,
    historyError,
    historySearch,
    hasMoreHistory,
    multiThread,
    openHistory,
    closeHistory,
    searchHistory,
    selectThread,
    deleteThread,
    loadMoreHistory,
    hydrateArchive,
    startNewChat,
  } =
    useOptionalAssistantConversation(endpoint);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [historyPortal, setHistoryPortal] = useState<HTMLElement | null>(null);
  const smsTestActive = usePortalAssistantConfig()?.smsTest?.active ?? false;

  // M013 — task-step resolution morph. `resolvingRef` remembers which
  // decision is in flight (set the instant the card's own button is
  // pressed, purely for bookkeeping — it never gates anything); the effect
  // below only shows the resolved flash once `pendingAction` genuinely
  // clears WITHOUT an error, i.e. strictly after the real confirm/deny
  // request already succeeded. A non-retryable failure also clears
  // `pendingAction` (use-assistant-conversation.ts's own contract) but sets
  // `error` in the same pass, so this never claims a failed action "Done".
  const resolvingRef = useRef<"confirm" | "deny" | null>(null);
  const prevPendingRef = useRef(pendingAction);
  const [resolvedFlash, setResolvedFlash] = useState<{ decision: "confirm" | "deny"; title: string } | null>(null);

  const firstName = managerName?.trim().split(/\s+/)[0] || null;
  const visibleMessages = visibleConversationMessages(messages);
  const hasConversation = visibleMessages.length > 0 || Boolean(pendingAction);
  const hint = contextHint?.trim() || null;
  const isVendorAssistant = endpoint === VENDOR_ASSISTANT_ENDPOINT;
  const isResidentAssistant = endpoint === RESIDENT_ASSISTANT_ENDPOINT;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    const previous = prevPendingRef.current;
    prevPendingRef.current = pendingAction;
    const decision = resolvingRef.current;
    if (!previous || pendingAction || !decision) return;
    resolvingRef.current = null;
    if (error) return; // a non-retryable failure also clears pendingAction — never flash "Done" for that.
    setResolvedFlash({ decision, title: previous.preview.title });
    const timer = setTimeout(() => setResolvedFlash(null), 1100);
    return () => clearTimeout(timer);
  }, [pendingAction, error]);

  useEffect(() => {
    void hydrateArchive();
  }, [hydrateArchive]);

  async function sendWithContext(prompt?: string) {
    await send(prompt, { contextHint: hint });
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card",
        className,
      )}
      data-attr="assistant-dock-panel"
    >
      <AssistantPanelHeader
        onClose={onClose}
        closeDataAttr="modal-assistant-close"
        showHistory={multiThread}
        onOpenHistory={openHistory}
        showNew={multiThread || hasConversation}
        onNew={() => {
          if (multiThread) {
            void startNewChat().then(() => requestAnimationFrame(() => inputRef.current?.focus()));
          } else {
            reset();
            requestAnimationFrame(() => inputRef.current?.focus());
          }
        }}
      />

      <AssistantSmsTestControl />

      <div ref={setHistoryPortal} className="relative flex min-h-0 flex-1 flex-col">
        {multiThread ? (
          <AssistantChatHistoryPanel
            open={historyOpen}
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={selectThread}
            onDelete={deleteThread}
            onNewChat={() => {
              void startNewChat().then(() => requestAnimationFrame(() => inputRef.current?.focus()));
            }}
            onClose={closeHistory}
            loading={historyLoading}
            error={historyError}
            searchQuery={historySearch}
            hasMore={hasMoreHistory}
            onRetry={openHistory}
            onLoadMore={loadMoreHistory}
            onSearchQueryChange={searchHistory}
            portalContainer={historyPortal}
          />
        ) : null}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-[18px] py-3.5"
      >
        {!hasConversation && smsTestActive ? (
          <p className="m-auto max-w-sm rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-center text-xs leading-relaxed text-muted">
            Send the same short replies you would text. Type YES or NO when the SMS assistant asks for confirmation.
          </p>
        ) : !hasConversation ? (
          <AssistantEmptyState
            firstName={firstName}
            hint={composerHint}
            // A modal's rail is framed around its task (a context hint says
            // so); only the portal-wide surfaces open on the manager's queue.
            showQueue={endpoint === MANAGER_ASSISTANT_ENDPOINT && !hint && !composerHint?.trim()}
            onPick={(prompt) => void sendWithContext(prompt)}
            disabled={loading}
            suggestions={isVendorAssistant ? VENDOR_ASSISTANT_SUGGESTIONS : isResidentAssistant ? RESIDENT_ASSISTANT_SUGGESTIONS : undefined}
          />
        ) : (
          <AssistantMessageList messages={visibleMessages} ratings={ratings} onRate={submitFeedback} loading={loading} />
        )}
      </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void sendWithContext();
        }}
        className={cn(
          "shrink-0 bg-card px-3.5 pb-3.5 pt-2.5",
          pinnedComposer && "sticky bottom-0 z-10",
        )}
      >
        {error ? <p role="alert" className="mb-2 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p> : null}
        {pendingAction ? (
          <AssistantPendingActionCard
            pendingAction={pendingAction}
            loading={loading}
            onResolve={(decision) => {
              resolvingRef.current = decision;
              void resolvePendingAction(decision);
            }}
          />
        ) : resolvedFlash ? (
          <AssistantResolvedActionFlash decision={resolvedFlash.decision} title={resolvedFlash.title} />
        ) : null}
        <AssistantChatComposer
          input={input}
          setInput={setInput}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onAttachmentError={(message) => setError(message)}
          loading={loading}
          inputRef={inputRef}
          inputId={inputId}
          inputAriaLabel="Ask the PropLane Assistant about your portfolio"
          placeholder={smsTestActive ? "Type an SMS message…" : isVendorAssistant ? "Ask about your jobs…" : isResidentAssistant ? "Ask about your home…" : "Ask about your portfolio…"}
          allowAttachments={!smsTestActive}

          onSend={() => void sendWithContext()}
        />
      </form>
    </div>
  );
}
