"use client";

/**
 * Step 2 — one card per property, one row per resident (room, lease dates,
 * rent, its source citation, and a plain status word — never a pill/Badge,
 * per AGENTS.md → Portal UI system). A `needs` row expands inline to answer
 * its `gaps[]`; every change goes through PATCH and the summary line below
 * recomputes from the server's response.
 */

import { useState } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  DoorOpen,
  EyeOff,
  Hash,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { cn } from "@/lib/utils";
import type {
  ImportGap,
  ImportResidentProposal,
  ImportRoomProposal,
  PortfolioImportProposal,
} from "@/lib/portfolio-import/types";

function formatSource(source: { rows?: number[]; page?: number } | undefined): string | null {
  if (!source) return null;
  if (source.page != null) return `p${source.page}`;
  if (source.rows && source.rows.length > 0) {
    return source.rows.length === 1 ? `row ${source.rows[0]}` : `rows ${source.rows[0]}–${source.rows[source.rows.length - 1]}`;
  }
  return null;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const GAP_FIELD_LABEL: Record<string, string> = {
  leaseEnd: "Needs end date",
  contact: "Needs contact",
  rent: "Needs rent",
  room: "Needs room",
};

function statusLabel(resident: Pick<ImportResidentProposal, "status" | "gaps">): { text: string; icon: typeof CheckCircle2 } {
  if (resident.status === "ready") return { text: "Ready", icon: CheckCircle2 };
  if (resident.status === "needs") {
    const first = resident.gaps[0]?.field;
    return { text: (first && GAP_FIELD_LABEL[first]) || "Needs answer", icon: AlertCircle };
  }
  return { text: "Skip", icon: EyeOff };
}

function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

function GapField({
  gap,
  value,
  rooms,
  onChange,
}: {
  gap: ImportGap;
  value: string;
  /** Only used for the `room` gap — a real pick from the property's actual rooms, never free text. */
  rooms: ImportRoomProposal[];
  onChange: (next: string) => void;
}) {
  const isDate = /date/i.test(gap.field);

  if (gap.field === "room") {
    return (
      <FieldSingleSelect
        label={gap.question}
        value={value}
        onChange={onChange}
        placeholder="Pick a room…"
        dataAttr={`portfolio-import-gap-${gap.field}`}
        wrapperClassName="max-w-xs"
        options={rooms.map((room) => ({ value: room.key, label: room.name }))}
      />
    );
  }

  return (
    <div>
      <label htmlFor={`gap-${gap.field}`} className="mb-1 block text-[12.5px] font-semibold text-foreground">
        {gap.question}
      </label>
      <input
        id={`gap-${gap.field}`}
        type={isDate ? "date" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-attr={`portfolio-import-gap-${gap.field}`}
        className="min-h-10 w-full max-w-xs rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground outline-none focus:border-primary"
      />
    </div>
  );
}

function ResidentRow({
  resident,
  rooms,
  onAnswer,
  onSetIncluded,
}: {
  resident: ImportResidentProposal;
  /** The property's actual rooms — only ever needed to answer a `room` gap. */
  rooms: ImportRoomProposal[];
  onAnswer: (residentKey: string, patch: Partial<ImportResidentProposal>) => void;
  onSetIncluded: (residentKey: string, included: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const status = statusLabel(resident);
  const citation = formatSource(resident.source);
  const expandable = resident.status === "needs" && resident.gaps.length > 0;

  /**
   * `residentGaps` (propose.ts) keys a gap "leaseEnd" | "contact" | "rent" |
   * "room" — none of those but "leaseEnd" is a real `ImportResidentProposal`
   * field name, so this maps each to the field(s) that actually clear it:
   * "room" sets `roomKey` (never free text — the field is a `<select>` of
   * the property's real rooms), "contact" sets `email` or `phone` depending
   * on which shape the manager typed, and "rent" is parsed to a number (the
   * type is `number | null`, never a string).
   */
  const commit = (field: string, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    let patch: Partial<ImportResidentProposal>;
    if (field === "leaseEnd" || field === "leaseStart") {
      patch = { [field]: value || null };
    } else if (field === "room") {
      patch = { roomKey: value || null };
    } else if (field === "contact") {
      patch = value.includes("@") ? { email: value || null } : { phone: value || null };
    } else if (field === "rent") {
      const parsed = value.trim() ? Number(value.replace(/[^0-9.]/g, "")) : null;
      patch = { rent: parsed != null && Number.isFinite(parsed) ? parsed : null };
    } else {
      patch = { [field]: value } as Partial<ImportResidentProposal>;
    }
    onAnswer(resident.key, patch);
  };

  return (
    <div className="border-t border-border first:border-t-0" data-attr="portfolio-import-resident-row">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary/[0.08] text-[12px] font-extrabold tracking-wide text-primary"
        >
          {initialsFor(resident.name)}
        </div>
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setExpanded((v) => !v)}
          data-attr="portfolio-import-resident-toggle"
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-default"
        >
          <span className="flex items-center gap-1 text-[14px] font-semibold text-foreground">
            {expandable ? (
              expanded ? (
                <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              )
            ) : null}
            <span className="truncate">{resident.name}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
            {resident.roomKey ? (
              <PortalRowFact icon={DoorOpen}>{resident.roomKey}</PortalRowFact>
            ) : (
              <PortalRowFact icon={DoorOpen}>No room</PortalRowFact>
            )}
            <PortalRowFact icon={Calendar}>
              {formatDate(resident.leaseStart)} – {formatDate(resident.leaseEnd)}
            </PortalRowFact>
            {citation ? <PortalRowFact icon={Hash}>{citation}</PortalRowFact> : null}
            <PortalRowFact icon={status.icon}>{status.text}</PortalRowFact>
          </span>
        </button>
        <span className="shrink-0 text-[14px] font-bold text-foreground">
          {resident.rent != null ? `$${resident.rent.toLocaleString()}/mo` : "—"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${resident.name}`}
              data-attr="portfolio-import-resident-menu"
              className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-attr="portfolio-import-resident-include" onSelect={() => onSetIncluded(resident.key, true)}>
              Include
            </DropdownMenuItem>
            <DropdownMenuItem data-attr="portfolio-import-resident-skip" onSelect={() => onSetIncluded(resident.key, false)}>
              Skip
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expandable && expanded ? (
        <div className="flex flex-col gap-3 border-t border-border bg-foreground/[0.02] px-3.5 py-3 pl-[3.25rem]">
          {resident.gaps.map((gap) => (
            <GapField
              key={gap.field}
              gap={gap}
              value={draft[gap.field] ?? ""}
              rooms={rooms}
              onChange={(next) => commit(gap.field, next)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyRoomRow({ roomName, onSkip }: { roomName: string; onSkip: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0" data-attr="portfolio-import-empty-room-row">
      <div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-foreground/[0.06] text-muted">
        <DoorOpen className="size-4" strokeWidth={1.6} />
      </div>
      <span className="min-w-0 flex-1 truncate text-[14px] text-foreground/70">{roomName} · Leave empty</span>
      <Button variant="ghost" onClick={onSkip} data-attr="portfolio-import-empty-room-skip">
        Skip
      </Button>
    </div>
  );
}

export function PortfolioImportReviewStep({
  proposal,
  saving,
  onAnswer,
  onSkipToggle,
  onContinue,
}: {
  proposal: PortfolioImportProposal;
  saving: boolean;
  onAnswer: (residentKey: string, patch: Partial<ImportResidentProposal>) => void;
  onSkipToggle: (key: string, included: boolean) => void;
  onContinue: () => void;
}) {
  const fileName = proposal.files[0]?.name ?? "your file";
  const roomCount = proposal.properties.reduce((sum, p) => sum + p.rooms.length, 0);
  const residentCount = proposal.properties.reduce((sum, p) => sum + p.residents.length, 0);
  const openItems = proposal.properties.reduce(
    (sum, p) => sum + p.residents.filter((r) => r.status === "needs").length,
    0,
  );
  const includedResidents = proposal.properties.reduce(
    (sum, p) => sum + p.residents.filter((r) => r.status !== "skip").length,
    0,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-0">
      <h1 className="mb-1 text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">Review what the agent found</h1>
      <p className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-foreground/70" data-attr="portfolio-import-summary-line">
        <span className="font-medium">{fileName}</span>
        <span aria-hidden>·</span>
        <span>
          {proposal.properties.length} {proposal.properties.length === 1 ? "property" : "properties"}
        </span>
        <span aria-hidden>·</span>
        <span>{roomCount} rooms</span>
        <span aria-hidden>·</span>
        <span>{residentCount} residents</span>
        <span aria-hidden>·</span>
        <span>{openItems} open {openItems === 1 ? "item" : "items"}</span>
      </p>

      <div className="flex flex-col gap-3">
        {proposal.properties.map((property) => (
          <div key={property.key} className="rounded-2xl border border-border bg-card" data-attr="portfolio-import-property-card">
            <div className="flex items-center justify-between gap-2 px-3.5 py-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold text-foreground">{property.address}</p>
                <p className="text-[12.5px] text-muted">
                  {property.rooms.length} {property.rooms.length === 1 ? "room" : "rooms"}
                </p>
              </div>
            </div>
            <div>
              {property.residents.map((resident) => (
                <ResidentRow key={resident.key} resident={resident} rooms={property.rooms} onAnswer={onAnswer} onSetIncluded={onSkipToggle} />
              ))}
              {property.rooms
                .filter((room) => !property.residents.some((r) => r.roomKey === room.key))
                .map((room) => (
                  <EmptyRoomRow
                    key={room.key}
                    roomName={room.name}
                    // Skipping an empty room is a real server-side skip
                    // (`applyAnswersAndSkips` drops it from `property.rooms`
                    // so it is never created) — same PATCH round trip a
                    // resident skip takes, not local-only UI state.
                    onSkip={() => onSkipToggle(room.key, false)}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className={cn("mt-6 flex justify-end")}>
        <Button variant="primary" loading={saving} onClick={onContinue} data-attr="portfolio-import-continue">
          {`Create ${includedResidents}…`}
        </Button>
      </div>
    </div>
  );
}
