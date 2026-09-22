"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  PortalPropertyRecordRow,
  PortalRowFact,
  type PortalRecordRowLeadingShape,
} from "@/components/portal/portal-record-row";

/**
 * The tile at the head of an entry row: a photo when the record has one,
 * round initials for a person, or a quiet glyph otherwise
 * (`docs/agents/record-page.md` "Lists"; the plan's `erow()`).
 */
export type PortalEntryRowTile =
  | { kind: "photo"; src: string; alt: string }
  | { kind: "initials"; label: string }
  | { kind: "glyph"; icon: LucideIcon; label?: string };

/**
 * One glyph fact on the row's place line — an icon and short text. A bare
 * string still renders (no icon fits every fact), but an `icon` is
 * preferred wherever the fact has one. `label` accepts a node (not just a
 * string) so a caller can carry a stable `data-attr` on the fact's text,
 * e.g. a payment row's next-reminder hint.
 */
export type PortalEntryRowFact = { icon?: LucideIcon; label: ReactNode; srLabel?: string } | string;

/** The right-hand figure: a bold value with a one-word sub-label, red only when late, green only when settled. */
export type PortalEntryRowFigure = {
  value: string;
  subLabel?: string;
  tone?: "ok" | "bad";
};

function renderTile(tile: PortalEntryRowTile): { node: ReactNode; shape: PortalRecordRowLeadingShape } {
  if (tile.kind === "photo") {
    return {
      shape: "square",
      node: (
        <img
          src={tile.src}
          alt={tile.alt}
          className="h-[4.125rem] w-[5.5rem] object-cover max-md:h-[3.125rem] max-md:w-16"
        />
      ),
    };
  }
  if (tile.kind === "initials") {
    const initials = tile.label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("");
    return {
      shape: "round",
      node: (
        <div
          aria-hidden
          className="grid h-[4.125rem] w-[4.125rem] place-items-center rounded-full bg-primary/[0.08] text-[20px] font-extrabold tracking-wide text-primary max-md:h-[3.125rem] max-md:w-[3.125rem] max-md:text-[16px]"
        >
          {initials || "?"}
        </div>
      ),
    };
  }
  const Icon = tile.icon;
  return {
    shape: "square",
    node: (
      <div
        aria-hidden={!tile.label}
        className="grid h-[4.125rem] w-[5.5rem] place-items-center rounded-[10px] bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-16"
      >
        <Icon className="size-6" strokeWidth={1.6} />
        {tile.label ? <span className="sr-only">{tile.label}</span> : null}
      </div>
    ),
  };
}

function renderFact(fact: PortalEntryRowFact, index: number) {
  if (typeof fact === "string") return <span key={index}>{fact}</span>;
  if (!fact.icon) return <span key={index}>{fact.label}</span>;
  return (
    <PortalRowFact key={index} icon={fact.icon} srLabel={fact.srLabel}>
      {fact.label}
    </PortalRowFact>
  );
}

/**
 * The one row every list renders (`docs/agents/record-page.md` "Lists";
 * `tests/unit/portal-list-rows-no-pills.test.ts`):
 *
 * tile · title (optional attention dot, never a pill) · place line
 * ("who · where · when") · up to three glyph facts · a right-hand figure
 * with a one-word sub-label (red when overdue, green when settled) · the
 * shared per-row ⋯ menu. The row itself opens the record — no `Badge`, no
 * pill, no inline button.
 *
 * Built on `PortalPropertyRecordRow` rather than a new row shell, so every
 * list keeps the one card, the one selection/⋯ wiring
 * (`RowSelectCheckbox` + `RecordActionContext`), and the one set of
 * responsive rules.
 */
export function PortalEntryRow({
  tile,
  title,
  attention = false,
  place,
  facts,
  figure,
  onOpen,
  onSelectedChange,
  selected,
  checked,
  omitActionView,
  selectLabel,
  dataAttr,
}: {
  tile: PortalEntryRowTile;
  title: string;
  /** A row needing the viewer's attention carries a blue dot before its title. */
  attention?: boolean;
  /** "who · where · when" — the line under the title. */
  place?: string;
  /** Up to three plain facts; anything past the third is dropped. */
  facts?: PortalEntryRowFact[];
  figure?: PortalEntryRowFigure;
  /** Omit for a row with nothing to open. */
  onOpen?: () => void;
  onSelectedChange?: (selected: boolean) => void;
  selected?: boolean;
  checked?: boolean;
  omitActionView?: boolean;
  /** What the ⋯ calls this row when the title alone is ambiguous. Defaults to the title. */
  selectLabel?: string;
  dataAttr?: string;
}) {
  const { node: tileNode, shape } = renderTile(tile);
  const factNodes = facts && facts.length ? facts.slice(0, 3).map(renderFact) : undefined;
  return (
    <PortalPropertyRecordRow
      title={title}
      attention={attention}
      address={place}
      facts={factNodes ? <>{factNodes}</> : undefined}
      leading={tileNode}
      leadingShape={shape}
      amount={figure?.value}
      amountTone={figure?.tone}
      amountSubLabel={figure?.subLabel}
      onOpen={onOpen}
      onSelectedChange={onSelectedChange}
      selected={selected}
      checked={checked}
      omitActionView={omitActionView}
      selectLabel={selectLabel}
      dataAttr={dataAttr}
    />
  );
}
