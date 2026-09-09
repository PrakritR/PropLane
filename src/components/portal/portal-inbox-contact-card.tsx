"use client";

/**
 * The compact number card at the top of a Communication conversation list.
 *
 * Manager, vendor and resident all render this one shape, so the three can
 * never drift apart.
 *
 * ## Why it is compact
 *
 * Each portal used to open with a hero: a 52px tile, a 20px number, two caption
 * lines and a pair of 42px buttons — around 250px before a single conversation
 * was drawn. That is most of a laptop's list. Nothing about the information was
 * wrong, only how much room it took, so this keeps every part of it and spends
 * about a third of the height: number, what the number is, the same actions as
 * icon buttons with their words as accessible names, and the readiness note
 * folded onto the caption line instead of claiming a line of its own.
 */
import type { ReactNode } from "react";

export type PortalInboxContactCardAction = {
  key: string;
  /** Accessible name and tooltip — the buttons are icon-only. */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** Rendered as an anchor when set (`sms:` / `mailto:` links). */
  href?: string;
  dataAttr?: string;
};

/** Tinted tile for a card whose leading slot is an icon rather than an avatar. */
export const PORTAL_INBOX_CONTACT_CARD_GLYPH_CLASS =
  "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-primary";

const ACTION_CLASS =
  "grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-primary/30 bg-card text-primary transition-colors hover:bg-primary/[0.08]";

export function PortalInboxContactCard({
  leading,
  value,
  label,
  note,
  noteTone = "muted",
  actions,
  dataAttr,
}: {
  /**
   * 36px slot, rendered exactly as given. The caller owns it because a phone
   * glyph wants the tinted tile and an avatar is already its own circle.
   */
  leading?: ReactNode;
  /** The number or name, and the line people actually read. */
  value: string;
  /** What the value is — "Your work number", "Your property manager". */
  label: string;
  /** Readiness or tenancy note, folded onto the label line rather than its own. */
  note?: string;
  noteTone?: "muted" | "warn";
  actions?: PortalInboxContactCardAction[];
  dataAttr?: string;
}) {
  return (
    <div className="shrink-0 px-3.5 pb-2.5 pt-3.5" data-attr={dataAttr}>
      <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/[0.05] px-3 py-2.5">
        {leading}
        <div className="min-w-0 flex-1">
          {/* The value earns its size. A phone number is short and wants to be
              big; an assistant address is 35 characters and the list pane is
              only ~400px wide, so at 16px it truncated mid-domain — which is
              the whole point of the card, cut off. Stepping down by length fits
              the long one without shrinking the short one. */}
          <p
            className={`truncate font-extrabold tabular-nums tracking-[-0.015em] text-foreground ${
              value.length > 32 ? "text-[12.5px]" : value.length > 24 ? "text-[14px]" : "text-[16px]"
            }`}
            title={value}
          >
            {value}
          </p>
          {/* The label and note share one truncating line, so the full sentence
              stays reachable on hover rather than being cut with no way to read
              it. */}
          <p className="truncate text-[12.5px] leading-snug text-muted" title={note ? `${label} · ${note}` : label}>
            {label}
            {note ? (
              <>
                {" · "}
                <span className={noteTone === "warn" ? "text-[var(--status-pending-fg)]" : undefined}>{note}</span>
              </>
            ) : null}
          </p>
        </div>
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
      </div>
    </div>
  );
}
