"use client";

import { useEffect, useRef, useState } from "react";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantChatHistoryPanel } from "@/components/portal/assistant-chat-history-panel";
import {
  AssistantEmptyState,
  AssistantMessageList,
  AssistantPanelHeader,
  MANAGER_ASSISTANT_ENDPOINT,
} from "@/components/portal/assistant-panel-chrome";
import { AssistantPendingActionCard } from "@/components/portal/assistant-shared";
import { useOptionalAssistantConversation } from "@/lib/axis-assistant/assistant-conversation-context";
import { visibleConversationMessages } from "@/lib/axis-assistant/use-assistant-conversation";
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
  /** When set, shows a collapse control in the header (desktop rail). */
  onCollapse?: () => void;
  /**
   * What `onCollapse` means to the user. The portal rail folds to a narrow
   * strip ("collapse"); a modal's assistant rail is removed entirely, so it
   * shows a labeled X ("close") that is distinct from the editor's own X.
   */
  collapseVariant?: "collapse" | "close";
  /** When set, shows a switch-to-popup control (desktop rail). */
  onUndockToPopup?: () => void;
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
  onCollapse,
  collapseVariant = "collapse",
  onUndockToPopup,
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

  const firstName = managerName?.trim().split(/\s+/)[0] || null;
  const visibleMessages = visibleConversationMessages(messages);
  const hasConversation = visibleMessages.length > 0 || Boolean(pendingAction);
  const hint = contextHint?.trim() || null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    void hydrateArchive();
  }, [hydrateArchive]);

  async function sendWithContext(prompt?: string) {
    await send(prompt, { contextHint: hint });
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-primary/15 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
        className,
      )}
      data-attr="assistant-dock-panel"
    >
      <AssistantPanelHeader
        onCollapse={onCollapse && collapseVariant === "collapse" ? onCollapse : undefined}
        onClose={onCollapse && collapseVariant === "close" ? onCollapse : undefined}
        closeDataAttr="modal-assistant-close"
        onUndockToPopup={onUndockToPopup}
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
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-3"
      >
        {!hasConversation ? (
          <AssistantEmptyState
            firstName={firstName}
            hint={composerHint}
            // A modal's rail is framed around its task (a context hint says
            // so); only the portal-wide surfaces open on the manager's queue.
            showQueue={endpoint === MANAGER_ASSISTANT_ENDPOINT && !hint && !composerHint?.trim()}
            onPick={(prompt) => void sendWithContext(prompt)}
            disabled={loading}
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
          "shrink-0 border-t border-border/60 bg-card px-3 pb-3 pt-3",
          pinnedComposer && "sticky bottom-0 z-10",
        )}
      >
        {error ? <p role="alert" className="mb-2 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p> : null}
        {pendingAction ? (
          <AssistantPendingActionCard
            pendingAction={pendingAction}
            loading={loading}
            onResolve={(decision) => void resolvePendingAction(decision)}
          />
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
          placeholder="Ask about your portfolio…"

          onSend={() => void sendWithContext()}
        />
      </form>
    </div>
  );
}
