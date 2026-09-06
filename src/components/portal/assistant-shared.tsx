import type { ReactNode } from "react";

import type { PendingAction } from "@/lib/axis-assistant/use-assistant-conversation";

/** Small four-point sparkle used across the assistant surfaces. */
export function AxisAssistantSparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 4.5l2.2 5.3 5.3 2.2-5.3 2.2L12 19.5l-2.2-5.3-5.3-2.2 5.3-2.2L12 4.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Thumbs rating for one assistant reply — the agent's ONLY quality signal.
 * Rendered by every assistant surface (popup and dock) so ratings can't depend
 * on which one a manager happens to prefer, and only for a message that carries
 * a `traceId` (i.e. Langfuse is configured and this turn was traced).
 *
 * Once rated it stays rated: re-scoring the same trace would overwrite the first
 * honest reaction, and an undo affordance invites exactly that. The chosen side
 * stays highlighted as the receipt.
 */
export function AssistantMessageRating({
  traceId,
  rating,
  onRate,
}: {
  traceId: string;
  rating?: "up" | "down";
  onRate: (traceId: string, rating: "up" | "down") => void;
}) {
  if (rating) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted" aria-live="polite">
        <span aria-hidden="true">{rating === "up" ? "👍" : "👎"}</span>
        <span>Thanks for the feedback</span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex items-center gap-1">
      <span className="sr-only" id={`rate-${traceId}`}>
        Was this response helpful?
      </span>
      {(["up", "down"] as const).map((value) => (
        <button
          key={value}
          type="button"
          data-attr={`assistant-rate-${value}`}
          aria-describedby={`rate-${traceId}`}
          aria-label={value === "up" ? "Helpful" : "Not helpful"}
          onClick={() => onRate(traceId, value)}
          className="min-h-[28px] min-w-[28px] rounded-full px-1.5 text-[13px] leading-none text-muted opacity-60 transition hover:bg-[var(--surface-muted)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
        >
          <span aria-hidden="true">{value === "up" ? "👍" : "👎"}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * "Pin to the right side" — a panel with its right column filled, i.e. what the
 * layout becomes once the assistant is docked.
 */
export function AssistantPinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M14 4v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5V4Z" fill="currentColor" />
    </svg>
  );
}

/** "Unpin" — the same panel with the right column emptied back out. */
export function AssistantUnpinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M14 4v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type AssistantSuggestion = {
  label: string;
  prompt: string;
  icon: ReactNode;
  toneClass: string;
};

/**
 * Empty-state suggestion chips shared by the floating panel and the dashboard
 * dock. Kept in one place so the two surfaces never drift.
 */
export const ASSISTANT_SUGGESTIONS: AssistantSuggestion[] = [
  {
    label: "Late on rent",
    prompt: "Who is late on rent right now?",
    toneClass: "text-[var(--status-overdue-fg)]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 8v4m0 4h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Lease pipeline",
    prompt: "Summarize my lease pipeline — manager review, resident signature pending, manager signature pending, and signed.",
    toneClass: "text-primary",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Applications",
    prompt: "How many rental applications are pending review, and who are the applicants?",
    toneClass: "text-[var(--status-pending-fg)]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12h.01M3 10h18"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "New listing",
    prompt:
      "I want to create a new rental listing. Walk me through what you need — address, beds and baths, rent, amenities, and photos — then save a draft I can review in Properties.",
    toneClass: "text-primary",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Draft a reminder",
    prompt: "Draft a rent reminder message for tenants who are overdue.",
    toneClass: "text-[var(--status-approved-fg)]",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

/** Suggestion chip grid for the assistant empty state. */
export function AssistantSuggestionChips({
  onPick,
  disabled,
  className,
}: {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      // An odd chip count leaves the last one alone in a two-column row; give it
      // the whole row so its label cannot wrap inside a fixed-height chip.
      className={`[&>*:last-child:nth-child(odd)]:col-span-2 ${
        className ?? "grid w-full grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center"
      }`}
    >
      {ASSISTANT_SUGGESTIONS.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => onPick(s.prompt)}
          disabled={disabled}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border bg-foreground/[0.04] px-3 text-xs font-medium text-foreground outline-none transition-[border-color,background-color,transform] hover:border-primary/25 hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:rounded-full"
        >
          <span className={`flex h-3.5 w-3.5 shrink-0 ${s.toneClass} [&_svg]:h-full [&_svg]:w-full`}>
            {s.icon}
          </span>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The write-action confirmation card: the exact preview (recipient, full body,
 * amount, date) the manager vetoes, plus Confirm / Cancel. Shared so the
 * floating panel and the dock present the gate identically. Confirm/Cancel route
 * through `useAssistantConversation.resolvePendingAction`, i.e. the server's
 * `claimPendingAction` re-validation — never a client-side execute.
 */
export function AssistantPendingActionCard({
  pendingAction,
  loading,
  onResolve,
}: {
  pendingAction: PendingAction;
  loading: boolean;
  onResolve: (decision: "confirm" | "deny") => void;
}) {
  return (
    <div className="mb-3 max-h-64 overflow-y-auto rounded-2xl border border-primary/25 bg-primary/5 p-3">
      <p className="text-xs font-semibold text-foreground">{pendingAction.preview.title}</p>
      <dl className="mt-2 space-y-1.5">
        {pendingAction.preview.fields.map((f, i) => (
          <div key={i} className="text-xs leading-relaxed">
            <dt className="font-medium text-muted">{f.label}</dt>
            <dd className="whitespace-pre-wrap text-foreground">{f.value}</dd>
          </div>
        ))}
      </dl>
      {pendingAction.preview.warnings?.map((w, i) => (
        <p
          key={i}
          className="mt-2 rounded-lg border border-[var(--status-pending-fg)]/25 bg-[var(--status-pending-fg)]/5 px-2 py-1.5 text-xs text-[var(--status-pending-fg)]"
        >
          {w}
        </p>
      ))}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => onResolve("confirm")}
          className="flex-1 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          {pendingAction.preview.confirmLabel}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => onResolve("deny")}
          className="rounded-full border border-border px-3 py-2 text-xs font-semibold text-muted disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
