import type { ReactNode } from "react";
import { CalendarClock, Clock3, FileText, MessageCircle, Receipt, Wrench } from "lucide-react";

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

export type AssistantSuggestion = {
  label: string;
  /** Sent as a chat prompt — ignored when `onSelect` is set. */
  prompt: string;
  icon: ReactNode;
  toneClass: string;
  /** A chip that does something other than send a chat prompt (e.g. opens a real modal). */
  onSelect?: () => void;
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
    prompt: "Draft a rent reminder message for residents who are overdue.",
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

/**
 * Vendor empty-state chips (VD23, 2026-09-27) — the vendor used to see this
 * same manager-shaped list ("Late on rent", "Applications", …). Every prompt
 * here maps to a real vendor tool (`docs/ai-assistant.md` § Vendor registry):
 * `list_my_bids`/`list_my_jobs`, `list_my_schedule`, `list_vendor_invoices`/
 * `list_vendor_payouts`, `send_message_to_manager`. "Set availability" is not
 * a chat prompt at all — it opens the real availability editor dialog
 * (`VendorAvailabilityEditor`, same as the Calendar page's own "Add
 * availability" action), matching the studio spec's "opens the modal".
 */
export const VENDOR_ASSISTANT_SUGGESTIONS: AssistantSuggestion[] = [
  {
    label: "Jobs to quote",
    prompt: "What services are waiting on a quote from me?",
    toneClass: "text-[var(--status-pending-fg)]",
    icon: <Wrench className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Today's visits",
    prompt: "What visits do I have scheduled today?",
    toneClass: "text-primary",
    icon: <CalendarClock className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Unpaid invoices",
    prompt: "Which of my invoices are still unpaid?",
    toneClass: "text-[var(--status-overdue-fg)]",
    icon: <Receipt className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Update a manager",
    prompt: "I want to send an update about a job to a property manager.",
    toneClass: "text-[var(--status-approved-fg)]",
    icon: <MessageCircle className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Set availability",
    prompt: "",
    toneClass: "text-primary",
    icon: <Clock3 className="h-full w-full" strokeWidth={2} />,
    // The editor only lives on the Calendar page — this chip is reachable
    // from anywhere in the portal, so it navigates there with a query flag
    // (read by `VendorCalendarPanel`) rather than dispatching the open event
    // directly, which a not-yet-mounted listener would simply drop.
    onSelect: () => {
      window.location.assign("/vendor/calendar?openAvailability=1");
    },
  },
];

/**
 * Resident empty-state chips (captain, Oct 7). Every prompt maps to a real tool in the
 * resident registry (`docs/ai-assistant.md` § Resident): `get_my_balance`, `get_my_lease`,
 * `create_service_request`, `send_message_to_manager`. Never the manager-shaped list. An
 * application-phase resident (or a free-tier manager's) has a smaller registry; the assistant
 * then answers those prompts with the matching portal link instead of a tool.
 */
export const RESIDENT_ASSISTANT_SUGGESTIONS: AssistantSuggestion[] = [
  {
    label: "My balance",
    prompt: "What's my balance?",
    toneClass: "text-[var(--status-overdue-fg)]",
    icon: <Receipt className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "My lease",
    prompt: "When does my lease end and what is my rent?",
    toneClass: "text-primary",
    icon: <FileText className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Open a service",
    prompt: "I need to open a service request.",
    toneClass: "text-[var(--status-pending-fg)]",
    icon: <Wrench className="h-full w-full" strokeWidth={2} />,
  },
  {
    label: "Message my manager",
    prompt: "I want to send a message to my property manager.",
    toneClass: "text-[var(--status-approved-fg)]",
    icon: <MessageCircle className="h-full w-full" strokeWidth={2} />,
  },
];

/** Suggestion chip grid for the assistant empty state. */
export function AssistantSuggestionChips({
  onPick,
  disabled,
  className,
  suggestions = ASSISTANT_SUGGESTIONS,
}: {
  onPick: (prompt: string) => void;
  disabled?: boolean;
  className?: string;
  suggestions?: AssistantSuggestion[];
}) {
  return (
    <div
      // An odd chip count leaves the last one alone in a two-column row; give it
      // the whole row so its label cannot wrap inside a fixed-height chip.
      className={`[&>*:last-child:nth-child(odd)]:col-span-2 ${
        className ?? "grid w-full grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center"
      }`}
    >
      {suggestions.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => (s.onSelect ? s.onSelect() : onPick(s.prompt))}
          disabled={disabled}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-[var(--input)] bg-card px-3.5 text-[13.5px] font-medium text-foreground outline-none transition-[border-color,background-color,transform] hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
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

/**
 * M013 — task-step resolution morph on assistant action cards.
 *
 * "The system narrates its work" (interior.dev's Task Steps, ported — see
 * ~/proplane-mock-kit/review-0927/interior-dev-research.md §2's "Task Steps"
 * row): today {@link AssistantPendingActionCard} resolving just unmounts —
 * the row below it (the assistant's own reply, "Done." or the tool's real
 * result) appears with no transition at all. This renders in the SAME slot
 * for one brief beat right after a genuine successful or denied resolution —
 * never on click, only once the caller's own success/failure state actually
 * lands, so it can never claim a still-in-flight action already finished.
 */
export function AssistantResolvedActionFlash({
  decision,
  title,
}: {
  decision: "confirm" | "deny";
  title: string;
}) {
  const isConfirm = decision === "confirm";
  return (
    <div
      className="motion-resolved-flash mb-3 flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5"
      role="status"
      aria-live="polite"
    >
      <span
        className={
          "grid h-6 w-6 shrink-0 place-items-center rounded-full " +
          (isConfirm ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]" : "bg-accent text-muted")
        }
      >
        {isConfirm ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <p className="min-w-0 truncate text-xs font-semibold text-foreground">
        {title} · {isConfirm ? "Done" : "Cancelled"}
      </p>
    </div>
  );
}
