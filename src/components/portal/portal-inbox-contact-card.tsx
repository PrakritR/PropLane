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
 * folded onto the label line instead of claiming a line of its own.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

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

function ContactIdentityRow({
  leading,
  value,
  label,
  note,
  noteTone = "muted",
  actions,
}: {
  leading?: ReactNode;
  value: string;
  label: string;
  note?: string;
  noteTone?: "muted" | "warn";
  actions?: PortalInboxContactCardAction[];
}) {
  return (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <p
          className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold tabular-nums text-foreground"
          title={note && noteTone === "warn" ? `${label}: ${value} — ${note}` : `${label}: ${value}`}
        >
          <span className="truncate">{value}</span>
          {note && noteTone === "warn" ? (
            <span className="shrink-0 text-xs font-normal text-[var(--status-pending-fg)]">{note}</span>
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
    </>
  );
}

export function PortalInboxContactCard({
  leading,
  value,
  label,
  note,
  noteTone = "muted",
  actions,
  secondary,
  dataAttr,
  padded = true,
  href,
  tone = "identity",
  disabled = false,
  frame = "card",
}: {
  /**
   * 36px slot, rendered exactly as given. The caller owns it because a phone
   * glyph wants the tinted tile and an avatar is already its own circle.
   * Omit it for a plain identity/setup box.
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
  /**
   * Second identity on the same card (work email under the work number).
   * Same row chrome as the primary so the two cannot drift.
   */
  secondary?: {
    leading?: ReactNode;
    value: string;
    label: string;
    actions?: PortalInboxContactCardAction[];
  };
  dataAttr?: string;
  /** When false, the caller owns outer spacing (stacked manager identity boxes). */
  padded?: boolean;
  /** Whole-card destination for an empty setup box. */
  href?: string;
  /** `setup` is the empty slot that will hold the live identity. */
  tone?: "identity" | "setup";
  disabled?: boolean;
  /** `inline` drops the per-row card chrome — stacked manager work identity uses one outer card. */
  frame?: "card" | "inline";
}) {
  const shell = (
    <div
      className={cn(
        frame === "inline"
          ? "min-w-0"
          : cn(
              "rounded-2xl border",
              tone === "setup" ? "border-border bg-card" : "border-border bg-card",
            ),
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <div className={cn("flex items-center gap-2", frame === "inline" ? "min-h-[34px] gap-2.5 py-0.5" : "px-3 py-1")}>
        <ContactIdentityRow
          leading={leading}
          value={value}
          label={label}
          note={note}
          noteTone={noteTone}
          actions={href ? undefined : actions}
        />
      </div>
      {secondary ? (
        <div
          className="flex items-center gap-2 border-t border-border px-3 py-1"
          data-attr="portal-inbox-contact-card-secondary"
        >
          <ContactIdentityRow
            leading={secondary.leading}
            value={secondary.value}
            label={secondary.label}
            actions={secondary.actions}
          />
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={padded ? "shrink-0 px-3 pb-2 pt-2" : "min-w-0"} data-attr={href && !disabled ? undefined : dataAttr}>
      {href && !disabled ? (
        <Link
          href={href}
          data-attr={dataAttr}
          className="block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          {shell}
        </Link>
      ) : (
        shell
      )}
    </div>
  );
}
