"use client";

import { ChevronsRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import {
  AssistantChatHistoryControls,
  AssistantChatHistoryPanel,
} from "@/components/portal/assistant-chat-history-panel";
import { AssistantMarkdown } from "@/components/portal/assistant-markdown";
import {
  AssistantUndockToPopupButton,
} from "@/components/portal/assistant-layout-controls";
import {
  AssistantMessageRating,
  AssistantPendingActionCard,
  AssistantSuggestionChips,
  AxisAssistantSparkleIcon,
} from "@/components/portal/assistant-shared";
import { userMessageContentFromInput } from "@/lib/assistant-chat-attachments.client";
import { useOptionalAssistantConversation } from "@/lib/axis-assistant/assistant-conversation-context";
import { cn } from "@/lib/utils";

export type AssistantDockPanelProps = {
  managerName?: string | null;
  endpoint?: string;
  /** Optional scope prefix sent with each user message (e.g. modal title). */
  contextHint?: string | null;
  className?: string;
  /** Tighter layout for modal footers. */
  compact?: boolean;
  /** Keep the composer pinned at the bottom; only message history scrolls. */
  pinnedComposer?: boolean;
  /** One-line hint above the composer when pinned in compact mode with no messages yet. */
  composerHint?: string | null;
  /** When set, shows a collapse control in the header (desktop rail). */
  onCollapse?: () => void;
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
  endpoint = "/api/agent/chat",
  contextHint = null,
  className,
  compact = false,
  pinnedComposer = false,
  composerHint = null,
  onCollapse,
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
  const hasConversation = messages.length > 0;
  const hint = contextHint?.trim() || null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    if (!compact) void hydrateArchive();
  }, [compact, hydrateArchive]);

  async function sendWithContext(prompt?: string) {
    if (!hint) {
      await send(prompt);
      return;
    }
    const rawBody = prompt?.trim() || userMessageContentFromInput(input, attachments);
    if (!rawBody) return;
    const body = rawBody.replace(/^\[Context:[^\]]+\]\s*/gim, "").trim() || rawBody;
    const scoped = `[Context: ${hint}]\n\n${body}`;
    if (prompt?.trim()) {
      await send(scoped);
    } else {
      setInput("");
      await send(scoped);
    }
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden",
        compact
          ? "rounded-xl border border-border bg-card"
          : "rounded-xl border border-primary/15 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
        className,
      )}
      data-attr="assistant-dock-panel"
    >
      {pinnedComposer && compact ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-primary">
            <AxisAssistantSparkleIcon className="h-4 w-4 shrink-0" />
            PropLane Assistant
          </p>
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted transition hover:bg-foreground/5 hover:text-foreground"
              data-attr="lease-edit-assistant-collapse"
              aria-expanded
            >
              Hide
              <ChevronsRight className="h-3.5 w-3.5 rotate-90" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {!compact ? (
        <div className="relative shrink-0 overflow-hidden border-b border-border/70 px-4 py-3">
          <div
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_10%,transparent),transparent_55%)]"
            aria-hidden
          />
          <div className="relative flex items-center gap-3">
            {onCollapse ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse PropLane Assistant"
                aria-expanded
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground"
                data-attr="portal-assistant-dock-collapse"
              >
                <ChevronsRight className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
                <AxisAssistantSparkleIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">PropLane Assistant</p>
                <p className="truncate text-xs text-muted">Ask about your portfolio in plain language</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
            {onUndockToPopup ? <AssistantUndockToPopupButton onClick={onUndockToPopup} /> : null}
            {multiThread ? (
              <AssistantChatHistoryControls
                onOpenHistory={openHistory}
                onNewChat={() => {
                  void startNewChat().then(() => requestAnimationFrame(() => inputRef.current?.focus()));
                }}
                showNewChat
              />
            ) : hasConversation ? (
              <button
                type="button"
                onClick={() => {
                  reset();
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                aria-label="Start a new conversation"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                  <path
                    d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={setHistoryPortal} className="relative flex min-h-0 flex-1 flex-col">
        {multiThread && !compact ? (
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
        className={cn(
          "flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3",
          pinnedComposer && compact
            ? hasConversation || loading
              ? "min-h-0 flex-1 py-2"
              : "shrink-0 py-1"
            : compact
              ? "min-h-0 flex-1 py-2"
              : "flex-1 py-4",
          !hasConversation && !compact && "flex-1",
        )}
      >
        {!hasConversation && compact && pinnedComposer ? (
          <p className="text-xs leading-relaxed text-muted">
            {composerHint?.trim() ||
              "Describe the change below — rent, dates, names, or other terms."}
          </p>
        ) : !hasConversation && !compact ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <AxisAssistantSparkleIcon className="h-5 w-5" />
            </span>
            <div className="flex flex-col gap-1">
              {firstName ? (
                <h2 className="text-base font-medium tracking-tight text-muted">Hi {firstName},</h2>
              ) : null}
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                What should we look at first?
              </h3>
              <p className="mx-auto max-w-[16rem] text-sm leading-relaxed text-muted">
                Rent, leases, applications, and reminders — grounded in your live portfolio data.
              </p>
            </div>
            <AssistantSuggestionChips
              onPick={(prompt) => void sendWithContext(prompt)}
              disabled={loading}
              className="grid w-full grid-cols-2 gap-2"
            />
          </div>
        ) : hasConversation ? (
          <div className="space-y-3 text-sm">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <span
                  className={
                    "inline-block max-w-[88%] rounded-2xl px-3.5 py-2.5 text-left " +
                    (m.role === "user"
                      ? "whitespace-pre-wrap rounded-br-md text-white shadow-[0_8px_20px_-12px_rgba(47,107,255,0.6)]"
                      : "rounded-bl-md border border-border bg-foreground/[0.04] text-foreground")
                  }
                  style={m.role === "user" ? { background: "var(--btn-primary)" } : undefined}
                >
                  {m.role === "user" ? m.content : <AssistantMarkdown text={m.content} />}
                </span>
                {m.role === "assistant" && m.traceId ? (
                  <AssistantMessageRating
                    traceId={m.traceId}
                    rating={ratings[m.traceId]}
                    onRate={submitFeedback}
                  />
                ) : null}
              </div>
            ))}
            {loading ? (
              <div className="flex w-fit items-center gap-2 rounded-2xl border border-border/70 bg-foreground/[0.03] px-3 py-2 text-muted">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70" />
                <span className="text-xs">Thinking…</span>
              </div>
            ) : null}
            {error ? (
              <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendWithContext();
        }}
        className={cn(
          "shrink-0 border-t border-border/60 bg-card px-3 pb-3 pt-3",
          compact && "pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] pt-2",
          pinnedComposer && "sticky bottom-0 z-10",
        )}
      >
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
          compact={compact}
          inputRef={inputRef}
          inputId={inputId}
          inputAriaLabel={inputId ? "Ask the PropLane Assistant about your portfolio" : undefined}
          placeholder={compact ? "Ask PropPlane to help — attach images or PDFs with the paperclip" : "Ask about your portfolio… Attach images or PDFs with the paperclip."}
          onSend={() => void sendWithContext()}
        />
      </form>
    </div>
  );
}
