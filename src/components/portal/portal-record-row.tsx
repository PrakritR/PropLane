"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Bath, BedDouble, DoorOpen, UserRound, type LucideIcon } from "lucide-react";
import { InboxAvatar, InboxConversationRow } from "@/components/portal/portal-inbox-ui";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";

/** Person-centric list row (residents, applications, vendors). */
export function PortalPersonRecordRow({
  name,
  subtitle,
  preview,
  meta,
  badge,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  omitActionView = false,
  dataAttr,
  trailing,
  rowId,
}: {
  name: string;
  subtitle?: string;
  preview?: string;
  meta?: string;
  badge?: ReactNode;
  selected?: boolean;
  /** Multi-select state. Pass `onSelectedChange` to show the checkbox at all. */
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  /** Bookings ⋯ is Edit + Delete — RecordActionMenu adds View when `onOpen` is set. */
  omitActionView?: boolean;
  dataAttr?: string;
  trailing?: ReactNode;
  /** Stable id for tests and deep links (e.g. `resident-application-AXIS-…`). */
  rowId?: string;
}) {
  // Opt-in, mirroring PortalPropertyRecordRow: a list that does not pass a
  // handler keeps exactly the layout it had before.
  const selectable = Boolean(onSelectedChange);
  return (
    <div data-attr={dataAttr} id={rowId}>
      <InboxConversationRow
        name={name}
        subtitle={subtitle}
        preview={preview ?? subtitle ?? ""}
        time={meta ?? ""}
        selected={selected || checked}
        onOpen={onOpen}
        trailing={trailing}
        leading={
          selectable ? (
            // Was `ml-3 mr-1 mt-1` on the bare box; each side minus the 12 px pad.
            <RowSelectCheckbox
              onOpenRecord={omitActionView ? undefined : onOpen}
              wrapperClassName="ml-0 -mr-2 -mt-2 self-start"
              checked={checked}
              onChange={(e) => onSelectedChange?.(e.target.checked)}
              aria-label={`Select ${name}`}
            />
          ) : undefined
        }
      />
      {badge ? <div className="px-3 pb-2 -mt-1 max-md:px-2.5">{badge}</div> : null}
    </div>
  );
}

/**
 * Property-style card row.
 *
 * Title, the address, a line of detail; on the right, a status chip
 * ("1 / 2 occupied") and the money in bold — the two things a manager scans a
 * list of homes for. On a phone the chip drops under the title and the money
 * stays on the right, so the row is still two lines and a glance.
 *
 * No chevron after the title: the whole row is the link and hover says so; the
 * old "2 ›" read as a count (PLAN-0914-1345). Bed / bath / room counts come as
 * glyphs (`meta`) rather than a grey sentence.
 */
export function PortalPropertyRecordRow({
  title,
  address,
  summary,
  meta,
  facts,
  badge,
  chip,
  trailing,
  leading,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  title: string;
  address: string;
  summary?: string;
  /** Bed / bath / room counts drawn as glyphs under the address. */
  meta?: { beds?: number; baths?: number; rooms?: number | null };
  /** Any other glyph facts on that same line — a person row's date, email, household. */
  facts?: ReactNode;
  badge?: ReactNode;
  /** Status chip — occupancy, stage — shown beside the money. */
  chip?: ReactNode;
  /** The money, right-aligned and bold. */
  trailing?: ReactNode;
  /** A thumbnail or glyph before the text — what makes one row recognisable among twenty. */
  leading?: ReactNode;
  selected?: boolean;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Omit for a row with nothing to open. A read-only list (finance entries)
   * still wants this row's typography, and rendering a button that does
   * nothing would announce itself to a screen reader as actionable.
   */
  onOpen?: () => void;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
  const openable = Boolean(onOpen);
  const body = (
    <>
      <p className="flex min-w-0 items-center gap-1 text-[15px] font-semibold leading-tight text-foreground">
        <span className="truncate">{title}</span>
      </p>
      <p className="truncate text-[13px] leading-relaxed text-muted">{address}</p>
      {facts ? (
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted" data-attr="record-row-facts">
          {facts}
        </p>
      ) : null}
      {meta && (meta.beds || meta.baths || meta.rooms) ? (
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted" data-attr="property-row-meta">
          {meta.beds ? (
            <span className="inline-flex items-center gap-1"><BedDouble className="size-3.5" strokeWidth={1.6} aria-hidden /><span className="sr-only">Bedrooms</span>{meta.beds}</span>
          ) : null}
          {meta.baths ? (
            <span className="inline-flex items-center gap-1"><Bath className="size-3.5" strokeWidth={1.6} aria-hidden /><span className="sr-only">Bathrooms</span>{meta.baths}</span>
          ) : null}
          {meta.rooms ? (
            <span className="inline-flex items-center gap-1"><DoorOpen className="size-3.5" strokeWidth={1.6} aria-hidden />{meta.rooms} {meta.rooms === 1 ? "room" : "rooms"}</span>
          ) : null}
        </p>
      ) : null}
      {summary ? <p className="truncate text-xs text-muted">{summary}</p> : null}
      {badge || chip || trailing ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {badge}
          {/* On a phone the chip and the money sit under the title, so the title
              keeps its width; on desktop both move to the right edge. */}
          {chip ? <span className="md:hidden">{chip}</span> : null}
          {trailing ? <span className="text-[13px] font-bold text-foreground md:hidden">{trailing}</span> : null}
        </div>
      ) : null}
    </>
  );
  const aside =
    chip || trailing ? (
      <div className="ml-2 hidden shrink-0 flex-col items-end justify-center gap-1 self-center text-right md:flex">
        {trailing ? <span className="whitespace-nowrap text-[14px] font-bold text-foreground">{trailing}</span> : null}
        {chip}
      </div>
    ) : null;
  return (
    <div
      className={cn(
        // One white card per property — no group heading, no repeated status
        // badge — with the row title opening the record and a separate 44px
        // selection target.
        "portal-property-row mb-2 flex w-full items-center gap-1 rounded-xl border bg-card px-3 py-3 shadow-sm transition-colors max-md:px-2.5 max-md:py-2.5",
        selected || checked ? "border-primary/40 bg-primary/[0.04]" : "border-border hover:border-primary/30",
      )}
    >
      {selectable ? (
        <RowSelectCheckbox
              onOpenRecord={onOpen}
          wrapperClassName="mr-0 self-center"
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          aria-label={`Select ${title}`}
        />
      ) : null}
      {leading ? <div className="mr-3 shrink-0 self-start">{leading}</div> : null}
      {openable ? (
        <button
          type="button"
          data-attr={dataAttr}
          onClick={onOpen}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left"
        >
          {body}
        </button>
      ) : (
        <div data-attr={dataAttr} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left">
          {body}
        </div>
      )}
      {aside}
    </div>
  );
}

/** A small status chip for a list row — "1 / 2 occupied", "Vacant". */
export function PortalRowStatusChip({
  tone = "neutral",
  children,
  dataAttr,
}: {
  tone?: "ok" | "warn" | "neutral";
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <span
      data-attr={dataAttr}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone === "ok"
          ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
          : tone === "warn"
            ? "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]"
            : "bg-[var(--secondary)] text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** One glyph fact on a record row — an icon and a short value. */
export function PortalRowFact({ icon: Icon, children, srLabel }: { icon: LucideIcon; children: ReactNode; srLabel?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon className="size-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * The Properties row, for a person — an applicant, a resident, a lease, a
 * charge, a vendor, a tour guest.
 *
 * Same card, same slots: an initials tile where the home has its photo, the
 * name as the title, "Alder Row · Room 2" as the address line, glyph facts,
 * the figure that matters (an amount, a date) in bold on the right, and the ⋯
 * the list surface draws for a selectable row. No pills: the tab says the
 * bucket, and anything else the row must say is a plain fact with a glyph
 * (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */
export function PortalApplicantRecordRow({
  name,
  kind = "applicant",
  tileLabel,
  ...rest
}: Omit<Parameters<typeof PortalPropertyRecordRow>[0], "title" | "leading" | "meta"> & {
  name: string;
  /** A co-signer gets a person glyph rather than initials, and sits under its applicant. */
  kind?: "applicant" | "cosigner";
  /**
   * Whose initials fill the tile when they are not the title's — a payment row
   * is titled by the resident but a vendor payout by the payee, and the tile
   * should always be the person the ⋯ acts for.
   */
  tileLabel?: string;
}) {
  const initials = (tileLabel ?? name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <PortalPropertyRecordRow
      title={name}
      leading={
        kind === "cosigner" ? (
          <div aria-hidden className="grid h-[4.125rem] w-[4.125rem] place-items-center rounded-[10px] bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-[3.125rem]">
            <UserRound className="size-[22px]" strokeWidth={1.5} />
          </div>
        ) : (
          <div aria-hidden className="grid h-[4.125rem] w-[5.5rem] place-items-center rounded-[10px] bg-primary/[0.08] text-[20px] font-extrabold tracking-wide text-primary max-md:h-[3.125rem] max-md:w-16 max-md:text-[16px]">
            {initials || "?"}
          </div>
        )
      }
      {...rest}
    />
  );
}

/** Generic service / work-order list row. */
export function PortalServiceRecordRow({
  title,
  subtitle,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  title: string;
  subtitle?: string;
  selected?: boolean;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
  const highlighted = selected || checked;

  return (
    <div
      className={`portal-service-row flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 transition-colors max-md:px-2.5 max-md:py-2.5 ${
        highlighted
          ? "border-l-[3px] border-l-primary bg-primary/[0.06]"
          : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
      }`}
    >
      {selectable ? (
        <RowSelectCheckbox
              onOpenRecord={onOpen}
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          aria-label={`Select ${title}`}
        />
      ) : null}
      <button
        type="button"
        data-attr={dataAttr}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <InboxAvatar name={title} className="h-9 w-9 shrink-0 text-[11px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      </button>
    </div>
  );
}
