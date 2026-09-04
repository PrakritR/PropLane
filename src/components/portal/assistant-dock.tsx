"use client";

import { useEffect, useRef } from "react";

import { AssistantMarkdown } from "@/components/portal/assistant-markdown";
import {
  AssistantPendingActionCard,
  AssistantSuggestionChips,
  AssistantUnpinIcon,
  AxisAssistantSparkleIcon,
} from "@/components/portal/assistant-shared";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";

/**
 * Inline, right-docked PropLane Assistant. It shares the exact conversation loop
 * (`useAssistantConversation`) and auth-gated `/api/agent/chat` endpoint the
 * floating popup uses — the same manager context resolver, the same
 * preview→confirm gate. This is presentation only: no new send/execute path, no
 * bypass of `claimPendingAction`.
 *
 * Rendered by `portal-assistant-dock-rail.tsx` inside a `hidden lg:flex` rail
 * and only for a manager who opted into docked mode, so on mobile/tablet — and
 * for everyone on the `popup` default — the FAB/popup remains the only
 * assistant surface.
 */
export function AssistantDock({
  managerName,
  endpoint = "/api/agent/chat",
  onUnpin,
}: {
  managerName?: string | null;
  endpoint?: string;
  /** Shown as an "unpin" control in the header when provided. */
  onUnpin?: () => void;
}) {
  const portalConfig = usePortalAssistantConfig();
  const resolvedEndpoint = portalConfig?.endpoint ?? endpoint;
  const resolvedName = managerName ?? portalConfig?.managerName ?? null;
  const { input, setInput, messages, pendingAction, loading, error, send, resolvePendingAction, reset } =
    useAssistantConversation(resolvedEndpoint);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const firstName = resolvedName?.trim().split(/\s+/)[0] || null;
  const hasConversation = messages.length > 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  // `data-attr` is deliberately unchanged now that the dock has moved off the
  // dashboard: PostHog autocapture Actions are keyed on the attribute value, so
  // renaming it would silently orphan the existing ones.
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-primary/15 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.03)]"
      data-attr="dashboard-assistant-dock"
    >
      <div className="relative shrink-0 overflow-hidden border-b border-border/70 px-4 py-3">
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_10%,transparent),transparent_55%)]"
          aria-hidden
        />
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]">
              <AxisAssistantSparkleIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                PropLane Assistant
              </p>
              <p className="truncate text-xs text-muted">Ask about your portfolio in plain language</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {hasConversation ? (
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
            {onUnpin ? (
              <button
                type="button"
                onClick={onUnpin}
                aria-label="Unpin PropLane Assistant, use the floating popup instead"
                title="Unpin — back to the floating popup"
                data-attr="assistant-dock-unpin"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25"
              >
                <AssistantUnpinIcon className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {!hasConversation ? (
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
                Rent, leases, reminders. Grounded in your live portfolio data.
              </p>
            </div>
            <AssistantSuggestionChips
              onPick={(prompt) => void send(prompt)}
              disabled={loading}
              className="grid w-full grid-cols-2 gap-2"
            />
          </div>
        ) : (
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
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="shrink-0 border-t border-border/60 bg-background/60 px-3 pb-3 pt-3"
      >
        {pendingAction ? (
          <AssistantPendingActionCard
            pendingAction={pendingAction}
            loading={loading}
            onResolve={(decision) => void resolvePendingAction(decision)}
          />
        ) : null}
        <div className="relative rounded-2xl border border-border bg-auth-input-bg shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow] duration-200 focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10">
          <textarea
            ref={inputRef}
            id={ASSISTANT_DOCK_INPUT_ID}
            aria-label="Ask the PropLane Assistant about your portfolio"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask about your portfolio…"
            className="max-h-32 min-h-[2.75rem] w-full resize-none [field-sizing:content] rounded-2xl bg-transparent py-3 pl-4 pr-12 text-sm text-foreground outline-none placeholder:text-muted/70"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send message"
            className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full text-white outline-none transition-[filter,opacity,transform] duration-200 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "var(--btn-primary)" }}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
