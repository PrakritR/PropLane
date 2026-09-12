"use client";

import Link from "next/link";
import { AppWindow, ChevronsRight, X } from "lucide-react";
import type { ReactNode } from "react";

import { AssistantMarkdown } from "@/components/portal/assistant-markdown";
import {
  AssistantMessageRating,
  AssistantPinIcon,
  AssistantSuggestionChips,
  AxisAssistantSparkleIcon,
} from "@/components/portal/assistant-shared";
import { useManagerAttentionQueue } from "@/hooks/use-manager-attention-queue";
import type { ChatMessage } from "@/lib/axis-assistant/use-assistant-conversation";
import type { ManagerAttentionRow } from "@/lib/manager-attention-queue";
import { cn } from "@/lib/utils";

/**
 * The assistant's chrome, shared by the floating popup and the docked rail so
 * the two never drift: a header of words, not glyphs; an empty state that is
 * the manager's own queue rather than a sparkle; and one message list.
 */

/** The manager endpoint — the only surface whose empty state is the manager's queue. */
export const MANAGER_ASSISTANT_ENDPOINT = "/api/agent/chat";

const WORD_BTN =
  "inline-flex h-8 shrink-0 items-center rounded-full px-2 text-[12.5px] font-semibold text-muted outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25";
const ICON_BTN =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25";

export function AssistantPanelHeader({
  titleId,
  onCollapse,
  onClose,
  closeDataAttr = "axis-assistant-close",
  onPinToRail,
  onUndockToPopup,
  showHistory,
  onOpenHistory,
  showNew,
  onNew,
  className,
}: {
  titleId?: string;
  /** Docked rail: fold the rail to a strip. Rendered at the left edge. */
  onCollapse?: () => void;
  /** Popup and modal strips: dismiss the assistant. Rendered at the right edge. */
  onClose?: () => void;
  closeDataAttr?: string;
  /** Popup on a desktop: pin into the right rail. */
  onPinToRail?: () => void;
  /** Rail: back to the floating popup. */
  onUndockToPopup?: () => void;
  showHistory: boolean;
  onOpenHistory: () => void;
  showNew: boolean;
  onNew: () => void;
  className?: string;
}) {
  return (
    <div className={cn("relative flex shrink-0 items-center gap-0.5 border-b border-border/70 px-2 py-2", className)}>
      {onCollapse ? (
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse PropLane Assistant"
          aria-expanded
          className={ICON_BTN}
          data-attr="portal-assistant-dock-collapse"
        >
          <ChevronsRight className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <AxisAssistantSparkleIcon className="h-3.5 w-3.5" />
        </span>
        <p className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
          <span aria-hidden>PropLane</span>
          <span id={titleId} className="sr-only">
            PropLane Assistant
          </span>
        </p>
      </div>
      {showNew ? (
        <button
          type="button"
          onClick={onNew}
          aria-label="Start a new conversation"
          data-attr="assistant-history-new-chat"
          className={WORD_BTN}
        >
          New
        </button>
      ) : null}
      {showHistory ? (
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label="Past conversations"
          data-attr="assistant-history-open"
          className={WORD_BTN}
        >
          History
        </button>
      ) : null}
      {onPinToRail ? (
        // Desktop-only: below `lg` there is no rail to pin into, so offering
        // the control there would be a dead end.
        <button
          type="button"
          onClick={onPinToRail}
          aria-label="Pin PropLane Assistant to the right side"
          title="Pin to the right side"
          data-attr="axis-assistant-pin-to-dock"
          className={cn(ICON_BTN, "hidden lg:grid")}
        >
          <AssistantPinIcon className="h-4 w-4" />
        </button>
      ) : null}
      {onUndockToPopup ? (
        <button
          type="button"
          onClick={onUndockToPopup}
          aria-label="Unpin PropLane Assistant, use the floating popup instead"
          title="Unpin — back to the floating popup"
          data-attr="assistant-undock-to-popup"
          className={ICON_BTN}
        >
          <AppWindow className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close PropLane Assistant"
          className={ICON_BTN}
          data-attr={closeDataAttr}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

const ROW_DOT: Record<ManagerAttentionRow["tone"], string> = {
  danger: "bg-[var(--status-overdue-fg)]",
  pending: "bg-[var(--status-pending-fg)]",
  info: "bg-primary",
};

/**
 * The manager's queue, in the same shell as the dashboard's Needs attention.
 * Rendered only for the manager surface; other roles keep the plain prompt.
 */
export function AssistantAttentionQueue({ onNavigate }: { onNavigate?: () => void }) {
  const { rows, ready } = useManagerAttentionQueue();
  if (!ready) return null;
  return (
    <section
      className="w-full overflow-hidden rounded-2xl border border-border bg-card text-left shadow-sm"
      data-attr="assistant-attention-queue"
      aria-label="Needs attention"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">Needs attention</h3>
        {rows.length > 0 ? (
          <span className="rounded-full bg-[var(--secondary)] px-2 py-px text-[11px] font-semibold tabular-nums text-muted">
            {rows.length}
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="px-3.5 py-4 text-center text-[13px] text-muted">Nothing is waiting on you. Nice.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2.5 px-3.5 py-2" data-attr={`assistant-attention-${row.id}`}>
              <span className={cn("size-2 shrink-0 rounded-full", ROW_DOT[row.tone])} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">{row.title}</span>
                <span className="block truncate text-[11.5px] text-muted">{row.detail}</span>
              </span>
              <Link
                href={row.href}
                onClick={onNavigate}
                className="inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-card px-2.5 text-[12px] font-semibold text-foreground transition hover:border-primary/40 hover:text-primary"
              >
                {row.actionLabel}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AssistantEmptyState({
  firstName,
  hint,
  showQueue,
  onNavigate,
  onPick,
  disabled,
  hideChips,
  className,
}: {
  firstName?: string | null;
  /** Replaces the default subline when the surface has its own task framing. */
  hint?: string | null;
  showQueue: boolean;
  onNavigate?: () => void;
  onPick: (prompt: string) => void;
  disabled?: boolean;
  hideChips?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-1 flex-col gap-3.5", className)} data-attr="assistant-empty-state">
      <div className="flex flex-col gap-0.5 px-0.5">
        {firstName ? <h2 className="text-[13px] font-medium text-muted">Hi {firstName},</h2> : null}
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">What should we look at first?</h3>
        <p className="text-[13px] leading-relaxed text-muted">{hint?.trim() || "Grounded in your live portfolio."}</p>
      </div>
      {showQueue ? <AssistantAttentionQueue onNavigate={onNavigate} /> : null}
      {hideChips ? null : (
        <AssistantSuggestionChips onPick={onPick} disabled={disabled} className="flex flex-wrap items-center gap-2" />
      )}
    </div>
  );
}

export function AssistantMessageList({
  messages,
  ratings,
  onRate,
  loading,
  trailing,
}: {
  messages: ChatMessage[];
  ratings: Record<string, "up" | "down" | undefined>;
  onRate: (traceId: string, rating: "up" | "down") => unknown;
  loading: boolean;
  trailing?: ReactNode;
}) {
  return (
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
            <AssistantMessageRating traceId={m.traceId} rating={ratings[m.traceId]} onRate={onRate} />
          ) : null}
        </div>
      ))}
      {loading ? (
        <div className="flex w-fit items-center gap-2 rounded-2xl border border-border/70 bg-foreground/[0.03] px-3 py-2 text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/70" />
          <span className="text-xs">Thinking…</span>
        </div>
      ) : null}
      {trailing}
    </div>
  );
}
