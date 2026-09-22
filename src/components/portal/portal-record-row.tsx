"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Bath, BedDouble, DoorOpen, UserRound, type LucideIcon } from "lucide-react";
import { InboxAvatar, InboxConversationRow } from "@/components/portal/portal-inbox-ui";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { usePortalListGroupFlushRow } from "@/components/portal/portal-list-group";

/**
 * A row's trailing status, in plain coloured text — never a pill or `Badge`
 * (`tests/unit/portal-list-rows-no-pills.test.ts`). The tab already says the
 * bucket; this is for the rare fact a row still has to say on top of that
 * ("Draft" inside Manager review, a flagged screening).
 */
export type PortalRecordRowStatusWord = { tone: "ok" | "warn" | "bad" | "neutral"; text: string };

const STATUS_WORD_TONE_CLASS: Record<PortalRecordRowStatusWord["tone"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-muted",
};

/** Plain coloured text, never a pill — the one way a row draws a status word. */
export function PortalRecordRowStatus({ tone, text }: PortalRecordRowStatusWord) {
  return <span className={cn("text-[13px] font-semibold", STATUS_WORD_TONE_CLASS[tone])}>{text}</span>;
}

/** Avatar/tile shape: square for a place, round for a person — see `leadingShape` below. */
export type PortalRecordRowLeadingShape = "square" | "round";

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
 * Title, the address, a line of detail; on the right, the money in bold — the
 * thing a manager scans a list of homes for. No status chip: the tab says the
 * bucket, anything else is a plain fact with a glyph. On a phone the money
 * drops under the title so the title keeps its width, and the row is still two
 * lines and a glance.
 *
 * No chevron after the title: the whole row is the link and hover says so; the
 * old "2 ›" read as a count (PLAN-0914-1345). Bed / bath / room counts come as
 * glyphs (`meta`) rather than a grey sentence.
 */
export function PortalPropertyRecordRow({
  title,
  attention = false,
  address,
  summary,
  meta,
  facts,
  badge,
  statusWord,
  trailing,
  amount,
  amountTone,
  amountSubLabel,
  leading,
  leadingShape,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  omitActionView = false,
  selectLabel,
  dataAttr,
}: {
  title: string;
  /** A row needing the viewer's attention carries a blue dot before its title — never a pill (`portal-entry-row.tsx`). */
  attention?: boolean;
  /** The place line ("who · where · when"). Omit for a row with none. */
  address?: string;
  /**
   * What the ⋯ and the hidden selection box call this row when the title alone
   * is ambiguous — a guest with two tours is "Maya Chen · Thu, Sep 17, 4:00 PM".
   * Defaults to the title.
   */
  selectLabel?: string;
  summary?: string;
  /** Bed / bath / room counts drawn as glyphs under the address. */
  meta?: { beds?: number; baths?: number; rooms?: number | null };
  /** Any other glyph facts on that same line — a person row's date, email, household. */
  facts?: ReactNode;
  /** @deprecated Pass `statusWord` — plain coloured text, never a pill. Kept so existing callers still compile. */
  badge?: ReactNode;
  /** The row's trailing status, in coloured text — never a pill. */
  statusWord?: PortalRecordRowStatusWord;
  /** @deprecated Pass `amount` — a plain string keeps every row's money in one format. Kept so existing callers still compile. */
  trailing?: ReactNode;
  /** The money, right-aligned and bold. */
  amount?: string;
  /** Colours `amount` red ("bad", e.g. overdue) or green ("ok"); unset keeps today's plain foreground. */
  amountTone?: "ok" | "bad";
  /** A one-word label under `amount` ("Pending", "per month") — the entry row's figure sub-label. */
  amountSubLabel?: string;
  /** A thumbnail or glyph before the text — what makes one row recognisable among twenty. */
  leading?: ReactNode;
  /** Clips `leading` to a shape: square for a place, round for a person. Unset keeps the caller's own shape (no clip) — every existing row before this prop shipped. */
  leadingShape?: PortalRecordRowLeadingShape;
  selected?: boolean;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Omit for a row with nothing to open. A read-only list (finance entries)
   * still wants this row's typography, and rendering a button that does
   * nothing would announce itself to a screen reader as actionable.
   */
  onOpen?: () => void;
  /** Bookings ⋯ is Edit + Delete — RecordActionMenu adds View when `onOpen` is set. */
  omitActionView?: boolean;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
  const openable = Boolean(onOpen);
  // Inside a `PortalListGroup`'s rows slot, drop this row's own card chrome —
  // the group's outer container already supplies the border/rounded
  // corners/shadow, and a hairline (the container's `divide-y`) separates
  // this row from its neighbors instead.
  const flush = usePortalListGroupFlushRow();
  // `statusWord`/`amount` are the current props; `badge`/`trailing` are the
  // deprecated ReactNode-shaped ones a handful of panels still pass. A caller
  // migrating one row at a time gets identical output either way.
  const badgeContent = statusWord ? <PortalRecordRowStatus {...statusWord} /> : badge;
  const trailingContent = trailing ?? (amount != null ? amount : undefined);
  const amountToneClass = amountTone ? STATUS_WORD_TONE_CLASS[amountTone] : "text-foreground";
  const body = (
    <>
      <p className="flex min-w-0 items-center gap-1 text-[15px] font-semibold leading-tight text-foreground">
        {attention ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
            <span className="sr-only">Needs attention</span>
          </>
        ) : null}
        <span className="truncate">{title}</span>
      </p>
      {address ? <p className="truncate text-[13px] leading-relaxed text-muted">{address}</p> : null}
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
      {badgeContent || trailingContent ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {badgeContent}
          {/* On a phone the money sits under the title, so the title keeps its
              width; on desktop it moves to the right edge. */}
          {trailingContent ? (
            <span className="inline-flex items-baseline gap-1 md:hidden">
              <span className={cn("text-[13px] font-bold", amountToneClass)}>{trailingContent}</span>
              {amountSubLabel ? <span className="text-[11px] font-medium text-muted">{amountSubLabel}</span> : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const aside =
    trailingContent ? (
      <div className="ml-2 hidden shrink-0 flex-col items-end justify-center gap-0.5 self-center text-right md:flex">
        <span className={cn("whitespace-nowrap text-[14px] font-bold", amountToneClass)}>{trailingContent}</span>
        {amountSubLabel ? <span className="whitespace-nowrap text-[11px] font-medium text-muted">{amountSubLabel}</span> : null}
      </div>
    ) : null;
  return (
    <div
      className={cn(
        // One white card per property when the row stands alone — no group
        // heading, no repeated status badge — with the row title opening the
        // record and a separate 44px selection target. Inside a
        // `PortalListGroup`, `flush` drops the card chrome so the row reads
        // as one line inside the group's single container instead.
        "portal-property-row flex w-full items-center gap-1 px-3 py-3 transition-colors max-md:px-2.5 max-md:py-2.5",
        flush
          ? selected || checked
            ? "bg-primary/[0.04]"
            : "hover:bg-foreground/[0.03]"
          : cn(
              "mb-2 rounded-xl border bg-card shadow-sm",
              selected || checked ? "border-primary/40 bg-primary/[0.04]" : "border-border hover:border-primary/30",
            ),
      )}
    >
      {selectable ? (
        <RowSelectCheckbox
          onOpenRecord={omitActionView ? undefined : onOpen}
          wrapperClassName="mr-0 self-center"
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          aria-label={`Select ${selectLabel ?? title}`}
        />
      ) : null}
      {leading ? (
        <div
          className={cn(
            "mr-3 shrink-0 self-start",
            leadingShape === "square" && "overflow-hidden rounded-[10px]",
            leadingShape === "round" && "overflow-hidden rounded-full",
          )}
        >
          {leading}
        </div>
      ) : null}
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
  // Every existing caller (residents, tours, applications, leases, vendors,
  // bookings, payments) renders this tile with none opting into a shape, so
  // the default must keep the pre-`leadingShape` look — the wide rounded
  // square tile — rather than silently turning every one of them into a
  // circular avatar. A caller wanting the round shape passes it explicitly.
  leadingShape = "square",
  ...rest
}: Omit<Parameters<typeof PortalPropertyRecordRow>[0], "title" | "leading" | "meta" | "leadingShape"> & {
  name: string;
  /** A co-signer gets a person glyph rather than initials, and sits under its applicant. */
  kind?: "applicant" | "cosigner";
  /**
   * Whose initials fill the tile when they are not the title's — a payment row
   * is titled by the resident but a vendor payout by the payee, and the tile
   * should always be the person the ⋯ acts for.
   */
  tileLabel?: string;
  /** Square keeps today's wide rectangular tile; round gives a circular avatar. */
  leadingShape?: PortalRecordRowLeadingShape;
}) {
  const initials = (tileLabel ?? name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  const tileRounding = leadingShape === "round" ? "rounded-full" : "rounded-[10px]";
  return (
    <PortalPropertyRecordRow
      title={name}
      leading={
        kind === "cosigner" ? (
          <div aria-hidden className={cn("grid h-[4.125rem] w-[4.125rem] place-items-center bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-[3.125rem]", tileRounding)}>
            <UserRound className="size-[22px]" strokeWidth={1.5} />
          </div>
        ) : (
          <div
            aria-hidden
            className={cn(
              "grid place-items-center bg-primary/[0.08] text-[20px] font-extrabold tracking-wide text-primary max-md:text-[16px]",
              tileRounding,
              // A round avatar reads as a circle only when it is square; a
              // square tile keeps its existing wider, photo-like proportions.
              leadingShape === "round"
                ? "h-[4.125rem] w-[4.125rem] max-md:h-[3.125rem] max-md:w-[3.125rem]"
                : "h-[4.125rem] w-[5.5rem] max-md:h-[3.125rem] max-md:w-16",
            )}
          >
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
