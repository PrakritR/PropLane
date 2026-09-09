"use client";

/**
 * The one-line number strip that sits above every Communication conversation
 * list — manager, vendor and resident.
 *
 * ## Why it is one line
 *
 * The three portals each used to open with a hero card: a 52px tile, a 20px
 * number, two caption lines and a pair of 42px buttons, ~250px before a single
 * conversation was drawn. Measured on a 1512x805 laptop that left 226px of
 * scroll — 2.8 rows. The requirement is EIGHT rows visible without scrolling,
 * so the card has to give up roughly four fifths of its height. At 56px it is
 * a fifth of what it was, and the saving is what makes the row count reachable
 * at all. (The rest comes from the row itself; the card alone gets to 6.3.)
 *
 * ## Nothing is deleted, it is relocated
 *
 * The captions the hero card carried were never actionable text — they said
 * what the number is for and whether it can send. Both survive: the sentence is
 * the strip's `title` and a visually-hidden line for screen readers, and the
 * readiness dot keeps its colour. What is gone is the space it took, not the
 * fact.
 *
 * Every portal's own file decides its label, leading glyph and actions; this
 * component owns only the shape, so the three can never drift apart again.
 */
import type { ReactNode } from "react";

export type PortalInboxNumberStripAction = {
  key: string;
  /** Accessible name — the strip is icon-only, so this is the ONLY label. */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** Rendered as an anchor when set (`sms:` / `mailto:` links). */
  href?: string;
  dataAttr?: string;
};

const ACTION_CLASS =
  "grid h-7 w-7 shrink-0 place-items-center rounded-full text-primary transition-colors hover:bg-primary/[0.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function PortalInboxNumberStrip({
  label,
  value,
  leading,
  actions,
  caption,
  ready,
  dataAttr,
}: {
  /** Short kind word — "Work number", "Your number", "Manager". */
  label: string;
  /** The number or name itself. */
  value: string;
  /** 24px glyph or avatar. */
  leading?: ReactNode;
  actions?: PortalInboxNumberStripAction[];
  /**
   * The sentence the hero card used to print under the number. It is not
   * dropped — it becomes the strip's title and its accessible description.
   */
  caption?: string;
  /** Green when the line can send, amber while it cannot. Omit for no dot. */
  ready?: boolean;
  dataAttr?: string;
}) {
  // The label and the value are already visible text, so repeating them for a
  // screen reader would announce the strip twice. Only the caption — the line
  // the hero card used to print and this one has no room for — is added.
  const described = caption ? `${label}: ${value}. ${caption}` : `${label}: ${value}`;

  return (
    <div className="shrink-0 px-3 pb-2 pt-3" data-attr={dataAttr}>
      <div
        className="flex h-9 items-center gap-2 rounded-full border border-primary/25 bg-primary/[0.06] pl-2.5 pr-1"
        title={described}
      >
        {leading ? (
          <span className="grid h-6 w-6 shrink-0 place-items-center text-primary" aria-hidden>
            {leading}
          </span>
        ) : null}
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-[0.06em] text-primary/70">
            {label}
          </span>
          <span className="truncate text-[13px] font-bold tabular-nums tracking-[-0.01em] text-foreground">
            {value}
          </span>
        </p>
        {typeof ready === "boolean" ? (
          <span
            className={`h-[6px] w-[6px] shrink-0 rounded-full ${
              ready ? "bg-[var(--status-confirmed-fg)]" : "bg-[var(--status-pending-fg)]"
            }`}
            aria-hidden
          />
        ) : null}
        {actions?.map((action) =>
          action.href ? (
            <a
              key={action.key}
              href={action.href}
              className={ACTION_CLASS}
              aria-label={action.label}
              title={action.label}
              data-attr={action.dataAttr}
            >
              {action.icon}
            </a>
          ) : (
            <button
              key={action.key}
              type="button"
              className={ACTION_CLASS}
              aria-label={action.label}
              title={action.label}
              data-attr={action.dataAttr}
              onClick={action.onClick}
            >
              {action.icon}
            </button>
          ),
        )}
        {caption ? <span className="sr-only">{caption}</span> : null}
      </div>
    </div>
  );
}
