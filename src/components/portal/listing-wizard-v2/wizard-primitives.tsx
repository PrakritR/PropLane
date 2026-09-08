"use client";

/**
 * The building blocks of the redesigned create-listing wizard.
 *
 * The layout rules these enforce come from form-usability research and are not
 * style preferences:
 *
 * - **One column.** A two-column form body measurably hurts completion, because
 *   the eye stops tracking a single path down the page. Two or three fields on
 *   ONE line (a city / state / ZIP row) is fine and is what `FieldRow` is for.
 * - **At most about seven fields on a screen.** Past that a step is split, or the
 *   remainder goes behind {@link MoreOptions}.
 * - **Both numbers in the progress indicator**, and named steps, so a manager can
 *   see how much is left rather than guessing.
 * - **Validate on blur, not on submit.** `error` renders under the field it
 *   belongs to; nothing is announced only at the end.
 */

import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────── shell ─────────────────────────── */

export function WizardModal({
  title,
  onClose,
  onSaveExit,
  children,
  footer,
  stepper,
  headerAside,
}: {
  title: string;
  onClose?: () => void;
  onSaveExit?: () => void;
  children: ReactNode;
  footer: ReactNode;
  stepper?: ReactNode;
  /** The Ask PropLane trigger — kept from the previous wizard, which managers use. */
  headerAside?: ReactNode;
}) {
  return (
    <div className="flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-28px_rgba(11,27,58,0.45)]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
        <b className="truncate text-[17px] font-bold tracking-tight text-foreground">{title}</b>
        <div className="flex shrink-0 items-center gap-2">
          {headerAside}
          {onSaveExit ? (
            <button
              type="button"
              onClick={onSaveExit}
              className="min-h-[36px] rounded-full border border-border bg-card px-4 text-[12.5px] font-bold text-foreground hover:bg-accent/40"
              data-attr="listing-v2-save-exit"
            >
              Save &amp; exit
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-accent/50"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      {stepper ? <div className="shrink-0 px-5 pt-4">{stepper}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">{children}</div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-accent/20 px-5 py-3.5">
        {footer}
      </div>
    </div>
  );
}

/** Named, numbered progress. Both numerator and denominator are always shown. */
export function WizardStepper({
  steps,
  current,
  onJump,
}: {
  steps: readonly { id: string; label: string }[];
  current: number;
  onJump?: (index: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, i) => {
        const done = i < current;
        const on = i === current;
        const reachable = i <= current;
        return (
          <li key={step.id}>
            <button
              type="button"
              disabled={!reachable || !onJump}
              onClick={() => reachable && onJump?.(i)}
              aria-current={on ? "step" : undefined}
              aria-label={`Step ${i + 1} of ${steps.length}: ${step.label}`}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 text-[12px] font-bold transition",
                on
                  ? "bg-primary/10 text-primary"
                  : done
                    ? "text-foreground hover:bg-accent/40"
                    : "cursor-default text-muted/45",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold",
                  done
                    ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                    : on
                      ? "bg-primary text-white"
                      : "border border-border text-muted/60",
                )}
                aria-hidden
              >
                {done ? "✓" : i + 1}
              </span>
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The heading block at the top of every step body. */
export function StepHeading({
  step,
  total,
  name,
  title,
  subtitle,
}: {
  step: number;
  total: number;
  name: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-5">
      <p className="mb-2 text-[12px] font-bold text-muted">
        Step {step} of {total} · {name}
      </p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">{title}</h2>
      {subtitle ? <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{subtitle}</p> : null}
    </div>
  );
}

/** Constrains a step body to a single readable column. */
export function StepColumn({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "max-w-3xl" : "max-w-[520px]"}>{children}</div>;
}

/* ─────────────────────────── fields ─────────────────────────── */

export function Field({
  label,
  required,
  optional,
  hint,
  error,
  children,
  group = false,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  /**
   * True when the control is a GROUP of buttons (chips) rather than one input.
   *
   * A single control is wrapped by its `<label>`, which associates the two
   * implicitly — no ids to keep in sync, and the label text is clickable. Doing
   * that around a row of chips would be wrong twice over: a label may only
   * describe one control, and clicking the text would silently toggle whichever
   * chip happened to come first. A group gets a `role="group"` with
   * `aria-labelledby` instead.
   */
  group?: boolean;
}) {
  const id = useId();
  const caption = (
    <>
      {label}
      {required ? <span className="ml-0.5 text-red-600">*</span> : null}
      {optional ? <span className="ml-1.5 text-[11px] font-semibold text-muted/75">optional</span> : null}
    </>
  );
  const note = error ? (
    <p className="mt-1.5 text-[12px] font-semibold text-red-600">{error}</p>
  ) : hint ? (
    <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{hint}</p>
  ) : null;

  if (group) {
    return (
      <div className="mb-4">
        <span id={id} className="mb-1.5 block text-[12.5px] font-bold text-foreground">
          {caption}
        </span>
        <div role="group" aria-labelledby={id}>
          {children}
        </div>
        {note}
      </div>
    );
  }
  return (
    <div className="mb-4">
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-bold text-foreground">{caption}</span>
        {children}
      </label>
      {note}
    </div>
  );
}

/**
 * Two or three fields on ONE line. This is the allowed exception to the single
 * column rule — it is for values that are read as one fact, like city/state/ZIP.
 */
export function FieldRow({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-3",
        cols === 4 && "grid-cols-2 sm:grid-cols-4",
      )}
    >
      {children}
    </div>
  );
}

/** A large tappable choice card — used where the answer changes the rest of the flow. */
export function ChoiceCard({
  selected,
  title,
  description,
  onSelect,
  dataAttr,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-attr={dataAttr}
      className={cn(
        "mb-2.5 flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
        selected ? "border-primary bg-primary/5 ring-[3px] ring-primary/10" : "border-border bg-card hover:bg-accent/30",
      )}
    >
      <span
        className={cn(
          "mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border-2 bg-card",
          selected ? "border-[5.5px] border-primary" : "border-border",
        )}
      />
      <span className="min-w-0">
        <b className="block text-[13.5px] font-bold text-foreground">{title}</b>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{description}</span>
      </span>
    </button>
  );
}

/**
 * Progressive disclosure. The long tail of a step lives here so the visible
 * screen stays under the field budget, while nothing is removed from the product.
 */
export function MoreOptions({
  label,
  open,
  onToggle,
  children,
  dataAttr,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-attr={dataAttr}
        className="w-full rounded-xl border border-dashed border-border px-3.5 py-3 text-left text-[13px] font-bold text-primary"
      >
        {label} {open ? "⌃" : "⌄"}
      </button>
      {open ? <div className="mt-4 border-l-2 border-border pl-4">{children}</div> : null}
    </div>
  );
}

/* ─────────────────────────── chips ─────────────────────────── */

export function ChipToggle({
  on,
  label,
  onToggle,
  dataAttr,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      data-attr={dataAttr}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-[12px] transition-colors",
        on
          ? "border-primary/35 bg-primary/10 font-bold text-primary"
          : "border-border bg-card font-semibold text-muted hover:bg-accent/40",
      )}
    >
      {label}
    </button>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/* ─────────────────────────── repeating rows ─────────────────────────── */

/**
 * The repeating-row list used for rooms, bathrooms and shared spaces.
 *
 * A row is thin and scannable so ten of them can be compared at a glance, which
 * a stack of tall cards makes impossible. Bulk editing complements per-row
 * editing rather than replacing it, and its action bar sits directly under the
 * rows it acts on.
 */
export function RowList({
  columns,
  children,
}: {
  columns: readonly { key: string; label: string; head?: ReactNode }[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div
        className="grid gap-2 border-b border-border bg-accent/25 px-3 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[0.1em] text-muted"
        style={{ gridTemplateColumns: rowTemplate(columns.length) }}
      >
        <span />
        {columns.map((c) => (
          <span key={c.key} className="truncate">
            {c.head ?? c.label}
          </span>
        ))}
        <span />
      </div>
      {children}
    </div>
  );
}

export function rowTemplate(dataColumns: number): string {
  return `24px repeat(${dataColumns}, minmax(0, 1fr)) 32px`;
}

export function Row({
  selected,
  onSelectChange,
  onOpen,
  onRemove,
  removeLabel,
  columnCount,
  children,
}: {
  selected: boolean;
  onSelectChange: (next: boolean) => void;
  onOpen?: () => void;
  onRemove?: () => void;
  removeLabel: string;
  columnCount: number;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0",
        selected ? "bg-primary/[0.04]" : "bg-card",
      )}
      style={{ gridTemplateColumns: rowTemplate(columnCount) }}
    >
      <label className="flex h-10 w-6 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelectChange(e.target.checked)}
          className="h-4 w-4 rounded border-border"
          aria-label={selected ? "Deselect row" : "Select row"}
        />
      </label>
      {children}
      <div className="flex items-center justify-end">
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={removeLabel}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted/70 hover:bg-accent/50"
          >
            ✕
          </button>
        ) : onOpen ? (
          <button type="button" onClick={onOpen} aria-label="Open" className="text-muted/70">
            ›
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One editable cell. `inherited` renders the house default in dashed grey so a
 * manager can tell at a glance which rooms they have actually customized.
 */
export function RowCell({
  value,
  placeholder,
  inherited,
  onChange,
  ariaLabel,
  inputMode,
}: {
  value: string;
  placeholder?: string;
  inherited?: boolean;
  onChange: (next: string) => void;
  ariaLabel: string;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      inputMode={inputMode}
      className={cn(
        "min-h-[38px] w-full rounded-lg border px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-primary",
        inherited ? "border-dashed border-border bg-accent/15 text-muted placeholder:text-muted" : "border-border bg-card",
      )}
    />
  );
}

/** The floating bar shown while rows are selected. */
export function RowBulkBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-full bg-foreground px-4 py-2 text-[12.5px] font-bold text-white">
      <span>{count} selected</span>
      {children}
    </div>
  );
}

export function BulkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-semibold text-white"
    >
      {children}
    </button>
  );
}

/**
 * The dashed ADD row from the rest of the portal — blue, uppercase, with the
 * section's own icon. Kept identical to `PortalListAddRow` so the wizard reads
 * as part of the product rather than as a separate form.
 */
export function AddRowButton({
  label,
  onClick,
  dataAttr,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  dataAttr?: string;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-attr={dataAttr}
      aria-label={label}
      className="mt-3 flex w-full items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-primary/45 bg-primary/[0.03] px-3 py-6 text-[12px] font-extrabold uppercase tracking-[0.14em] text-primary transition hover:bg-primary/[0.07]"
    >
      {Icon ? <Icon className="h-5 w-5" aria-hidden /> : null}
      {label}
    </button>
  );
}
