"use client";

import { useState, type ReactNode } from "react";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PortalTableExpandChevron } from "@/components/portal/portal-data-table";
import {
  HOUSE_INFO_SECTIONS,
  getHouseInfoValue,
  houseInfoRenderSections,
  houseInfoSectionCount,
  houseInfoSectionIsEmpty,
  type HouseInfoField,
  type HouseInfoSectionId,
  type HouseInfoSectionSpec,
  type HouseInfoV1,
} from "@/lib/house-info";

/** Trailing `>` / `v` at the end of a house-details row (captain override). */
export function HouseDetailsExpandable({
  defaultOpen = false,
  dataAttr,
  title,
  badge,
  count,
  actions,
  onOpenChange,
  children,
}: {
  defaultOpen?: boolean;
  dataAttr?: string;
  title: string;
  badge?: ReactNode;
  count?: { filled: number; total: number };
  /** Right-aligned utilities before the count and chevron. Clicks do not toggle. */
  actions?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="overflow-hidden rounded-2xl border border-border bg-card"
      open={open}
      data-attr={dataAttr}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {badge}
        <span className="flex-1" />
        {actions ? (
          <span
            className="flex shrink-0 items-center gap-0.5"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {actions}
          </span>
        ) : null}
        {count ? <SectionCountPill filled={count.filled} total={count.total} /> : null}
        <PortalTableExpandChevron expanded={open} />
      </summary>
      <div className="border-t border-border px-4 pb-4 pt-3">{children}</div>
    </details>
  );
}

/**
 * The one renderer for structured house details, in two modes: the manager
 * fills it in, the resident reads it. Keeping both here means a field added to
 * `HOUSE_INFO_SECTIONS` cannot appear on one side and go missing on the other.
 */

/* ─────────────────────────────  manager editor  ──────────────────────────── */

export function SectionCountPill({ filled, total }: { filled: number; total: number }) {
  const full = filled === total && total > 0;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        full ? "portal-badge-info" : "bg-[var(--pl-surface-muted)] text-muted"
      }`}
    >
      {filled} of {total}
    </span>
  );
}

function FieldControl({
  spec,
  field,
  info,
  onChange,
}: {
  spec: HouseInfoSectionSpec;
  field: HouseInfoField;
  info: HouseInfoV1;
  onChange: (key: string, value: string) => void;
}) {
  const value = getHouseInfoValue(info, spec.id, field.key);

  if (field.kind === "timeRange" && field.pairKey) {
    const to = getHouseInfoValue(info, spec.id, field.pairKey);
    const pairKey = field.pairKey;
    return (
      <div className="flex items-end gap-2">
        <Input
          type="time"
          aria-label={`${field.label} start`}
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
        <span className="pb-3 text-xs text-muted">to</span>
        <Input
          type="time"
          aria-label={`${field.label} end`}
          value={to}
          onChange={(e) => onChange(pairKey, e.target.value)}
        />
      </div>
    );
  }

  if (field.kind === "select") {
    const options = field.options ?? [];
    // A migrated value the presets do not cover is offered as-is rather than
    // snapped to the nearest one — the manager's own wording survives.
    const custom = value && !options.includes(value) ? value : null;
    return (
      <Select
        aria-label={field.label}
        value={value}
        onChange={(e) => onChange(field.key, e.target.value)}
      >
        <option value="">Not set</option>
        {custom ? <option value={custom}>{custom}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }

  if (field.kind === "textarea") {
    return (
      <Textarea
        rows={2}
        aria-label={field.label}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    );
  }

  return (
    <Input
      type={field.kind === "url" ? "url" : "text"}
      aria-label={field.label}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(field.key, e.target.value)}
    />
  );
}

function EditorSection({
  spec,
  info,
  onChange,
  defaultOpen,
}: {
  spec: HouseInfoSectionSpec;
  info: HouseInfoV1;
  onChange: (sectionId: HouseInfoSectionId, key: string, value: string) => void;
  defaultOpen: boolean;
}) {
  const count = houseInfoSectionCount(info, spec);
  return (
    <HouseDetailsExpandable
      defaultOpen={defaultOpen}
      dataAttr={`house-info-section-${spec.id}`}
      title={spec.label}
      badge={
        <span className="portal-badge-info rounded-full px-2 py-0.5 text-[10px] font-semibold">
          Residents only
        </span>
      }
      count={count}
    >
      {spec.blurb ? <p className="mb-3 text-xs text-muted">{spec.blurb}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {spec.fields.map((field) => (
          <div key={field.key} className={field.kind === "textarea" ? "sm:col-span-2" : undefined}>
            <label className="mb-1.5 block text-xs font-semibold text-muted">{field.label}</label>
            <FieldControl
              spec={spec}
              field={field}
              info={info}
              onChange={(key, value) => onChange(spec.id, key, value)}
            />
            {field.hint ? <p className="mt-1 text-[11px] text-muted">{field.hint}</p> : null}
          </div>
        ))}
      </div>
    </HouseDetailsExpandable>
  );
}

export function HouseInfoEditor({
  info,
  onChange,
  onOtherChange,
}: {
  info: HouseInfoV1;
  onChange: (sectionId: HouseInfoSectionId, key: string, value: string) => void;
  onOtherChange: (value: string) => void;
}) {
  const [showOptional, setShowOptional] = useState(
    () => !HOUSE_INFO_SECTIONS.every((spec) => !spec.optional || houseInfoSectionIsEmpty(info, spec)),
  );

  const visible = HOUSE_INFO_SECTIONS.filter(
    (spec) => !spec.optional || showOptional || !houseInfoSectionIsEmpty(info, spec),
  );
  const hiddenCount = HOUSE_INFO_SECTIONS.length - visible.length;

  return (
    <div className="space-y-2.5">
      {visible.map((spec) => (
        <EditorSection
          key={spec.id}
          spec={spec}
          info={info}
          onChange={onChange}
          // An empty optional section opens closed — it is a suggestion, not a
          // form to fill. Everything else opens where the work is.
          defaultOpen={!spec.optional && !houseInfoSectionIsEmpty(info, spec)}
        />
      ))}

      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="w-full rounded-2xl border border-dashed border-border px-4 py-3 text-xs font-semibold text-muted hover:border-primary/40 hover:text-foreground"
          data-attr="house-info-show-optional"
        >
          Add {hiddenCount} more {hiddenCount === 1 ? "section" : "sections"} (laundry, safety)
        </button>
      ) : null}

      <HouseDetailsExpandable
        dataAttr="house-info-section-other"
        title="Anything else"
        badge={
          <span className="portal-badge-info rounded-full px-2 py-0.5 text-[10px] font-semibold">
            Residents only
          </span>
        }
        count={{ filled: info.other.trim() ? 1 : 0, total: 1 }}
      >
        <label className="mb-1.5 block text-xs font-semibold text-muted">
          Anything else residents should know
        </label>
        <Textarea
          rows={3}
          aria-label="Anything else residents should know"
          value={info.other}
          placeholder="Free text. Whatever did not fit a section above."
          onChange={(e) => onOtherChange(e.target.value)}
        />
      </HouseDetailsExpandable>
    </div>
  );
}

/* ────────────────────────────  resident read view  ───────────────────────── */

function CopyValueButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        copied ? "border-[var(--status-confirmed-fg)] text-[var(--status-confirmed-fg)]" : "border-border text-muted hover:border-primary/40 hover:text-foreground"
      }`}
      data-attr="house-info-copy"
      onClick={() => {
        // Clipboard access is not guaranteed (insecure origin, denied
        // permission). The row still reads fine, so a failure is silent rather
        // than an error the resident cannot act on.
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The resident-facing card stack. Returns null when nothing is filled so the
 * caller can fall back to legacy free text or its own empty state.
 */
export function HouseInfoReadSections({ info }: { info: HouseInfoV1 | null | undefined }) {
  const sections = houseInfoRenderSections(info);
  const other = info?.other.trim() ?? "";
  if (sections.length === 0 && !other) return null;

  return (
    <div className="space-y-3" data-attr="house-info-read">
      {sections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-border bg-card px-4 py-3">
          <h3 className="mb-1 text-sm font-semibold text-foreground">{section.label}</h3>
          <dl>
            {section.rows.map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 py-2.5 last:border-0"
              >
                <dt className="w-full shrink-0 text-xs text-muted sm:w-40">{row.label}</dt>
                <dd className={`min-w-0 flex-1 break-words text-sm ${row.copyable ? "font-mono font-semibold tracking-wide" : ""}`}>
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      Join the house chat
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
                {row.copyable ? <CopyValueButton value={row.value} /> : null}
              </div>
            ))}
          </dl>
        </section>
      ))}

      {other ? (
        <section className="rounded-2xl border border-border bg-card px-4 py-3">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Good to know</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{other}</p>
        </section>
      ) : null}
    </div>
  );
}

/**
 * How the portal itself works — Services, Payments, Lease, Inbox.
 *
 * PropLane owns this copy. Before, every manager retyped the same paragraphs
 * into each property's house info, where it went stale the moment the portal
 * changed. It is not a field and never has been a manager's job.
 */
export function ResidentPortalHelpCard() {
  return (
    <section
      className="rounded-2xl border border-primary/25 bg-[var(--pl-accent-soft)] px-4 py-3"
      data-attr="resident-portal-help"
    >
      <h3 className="mb-1.5 text-sm font-semibold text-foreground">How your portal works</h3>
      <ul className="space-y-1.5 text-sm leading-relaxed text-foreground">
        <li>
          <b>Services</b> — report maintenance or request an add-on. Your property manager is notified automatically,
          so there is nobody to text.
        </li>
        <li>
          <b>Payments</b> — pay rent and see every charge on your account.
        </li>
        <li>
          <b>Lease</b> — read your terms, and ask to extend when you are ready.
        </li>
        <li>
          <b>Inbox</b> — message your property manager. Everything stays documented.
        </li>
      </ul>
    </section>
  );
}
