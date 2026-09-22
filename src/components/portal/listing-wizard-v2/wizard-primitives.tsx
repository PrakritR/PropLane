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

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Camera, ChevronRight, RotateCcw, type LucideIcon } from "lucide-react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { cn } from "@/lib/utils";

/* ─────────────────────────── shell ─────────────────────────── */

/**
 * A small single-column modal — the shape a short question flow wants.
 *
 * The listing EDITOR outgrew this and uses {@link ListingWorkspace} instead; this
 * is what {@link AddPropertyFlow}'s three questions still render in, where a
 * step rail and a preview panel would be furniture around two fields.
 */
export function WizardModal({
  title,
  onClose,
  children,
  footer,
  headerAside,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer: ReactNode;
  headerAside?: ReactNode;
}) {
  return (
    <div className="flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-[0_24px_60px_-28px_rgba(11,27,58,0.45)] [html[data-theme=dark]_&]:bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-5">
        <b className="truncate text-[19px] font-bold tracking-tight text-foreground">{title}</b>
        <div className="flex shrink-0 items-center gap-2">
          {headerAside}
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
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-6 py-6 [html[data-theme=dark]_&]:bg-card">{children}</div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-white px-6 py-4 [html[data-theme=dark]_&]:bg-card">
        {footer}
      </div>
    </div>
  );
}

/**
 * The three-pane listing workspace: a step rail, the step body, and a panel that
 * shows what the manager just changed.
 *
 * It replaces the single-column modal the wizard opened in. The modal was the
 * reason nothing on screen ever answered "what does the resident actually pay"
 * — there was no room for an answer next to the question. The panel is not
 * decoration: every step supplies its own, and a step with nothing useful to
 * show does not get one.
 *
 * Under 1180px the panel drops out of the grid; steps render it at the foot of
 * the body instead (see `sidePanel` / `sideBelow`), so a phone loses the column
 * and keeps the content.
 */
export function ListingWorkspace({
  title,
  subtitle,
  badge,
  saveState,
  onClose,
  closeDisabled = false,
  rail,
  railHeader,
  railFooter,
  children,
  sidePanel,
  footer,
  headerAside,
  headerCenter,
}: {
  title: string;
  subtitle?: string;
  /** "Listed" / "Draft" — what this listing is right now. */
  badge?: ReactNode;
  /** Autosave status, stated once, in the header. */
  saveState?: ReactNode;
  onClose?: () => void;
  /**
   * Disables the ✕ while a save/publish is already in flight, the same
   * `busy` guard the footer's Save / Publish / Back / Continue buttons use
   * (PRP-486) — a click that lands while it is already saving used to be
   * silently dropped.
   */
  closeDisabled?: boolean;
  rail: ReactNode;
  /**
   * What sits ABOVE the sections in the rail — the cover photo and, while
   * something still needs doing, the "finish these" card. Desktop only: on a
   * phone the rail is a strip of chips and has no room for it.
   */
  railHeader?: ReactNode;
  /** Pinned to the foot of the rail — the listing's live/draft status. Desktop only. */
  railFooter?: ReactNode;
  children: ReactNode;
  sidePanel?: ReactNode;
  footer: ReactNode;
  /** The Ask PropLane trigger — kept from the previous wizard, which managers use. */
  headerAside?: ReactNode;
  /**
   * Between the title and the save state — the import's "1 of 6 · 400 Pike St"
   * switcher. Stays visible on a phone, where the subtitle steps aside for it.
   */
  headerCenter?: ReactNode;
}) {
  /**
   * Escape reaches the same `onClose` the ✕ calls, even while `closeDisabled`
   * has the button itself unclickable — PRP-486's toast-instead-of-silence
   * fix lives in `onClose` (`handleClose`'s own in-flight guard), not in
   * whether this key can knock on the door.
   */
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border-0 bg-white shadow-[0_24px_60px_-28px_rgba(11,27,58,0.45)] sm:rounded-2xl sm:border sm:border-border [html[data-theme=dark]_&]:bg-card">
      {/*
       * The native shell draws under the status bar, so on a phone the header
       * pads by the safe-area inset the way Modal and the auth layout do;
       * the website (no inset) pads zero. Same again for the footer and the
       * home indicator.
       */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-5 py-3 [html[data-native]_&]:pt-[max(0.75rem,var(--native-safe-top,0px))]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <b className="truncate text-[15px] font-bold tracking-tight text-foreground sm:text-[17px]">{title}</b>
            <span className="shrink-0">{badge}</span>
          </div>
          {/* On a phone the address and the save state lose to the title and the
              close control, so they step aside rather than wrapping into three rows. */}
          {subtitle ? <p className="hidden truncate text-[12.5px] text-foreground/70 sm:block">{subtitle}</p> : null}
        </div>
        {headerCenter ? <div className="min-w-0 shrink-0">{headerCenter}</div> : null}
        {saveState ? (
          <div
            className="shrink-0 text-[12.5px] font-semibold text-foreground"
            data-testid="listing-wizard-autosave-status"
          >
            {saveState}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-2">
          {headerAside}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="Close"
              className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-45"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      {/*
       * On a phone the rail row is as tall as its chips and the body takes the
       * rest; without the explicit rows a short step (the import's Upload) let
       * the grid split its spare height between the two and the rail grew a
       * band of empty grey under the chips.
       */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[252px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[252px_minmax(0,1fr)_340px]">
        <nav
          aria-label="Listing sections"
          className="flex min-h-0 shrink-0 flex-col overflow-x-auto border-b border-border/60 bg-[var(--pl-surface-muted)] p-2 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-3 [html[data-theme=dark]_&]:bg-black/20"
        >
          {railHeader ? <div className="hidden lg:block">{railHeader}</div> : null}
          {rail}
          {railFooter ? <div className="mt-auto hidden pt-4 lg:block">{railFooter}</div> : null}
        </nav>
        <main className="min-h-0 min-w-0 overflow-y-auto px-5 py-6 lg:px-8">{children}</main>
        {sidePanel ? (
          <aside
            aria-label="Live panel"
            className="hidden min-h-0 overflow-y-auto border-l border-border/60 bg-[var(--pl-surface-muted)] p-4 xl:block [html[data-theme=dark]_&]:bg-black/20"
          >
            {sidePanel}
          </aside>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/60 bg-white px-4 py-3 sm:px-5 [html[data-native]_&]:pb-[max(0.75rem,var(--native-safe-bottom,0px))] [html[data-theme=dark]_&]:bg-card">
        {footer}
      </div>
    </div>
  );
}

/**
 * Where the panel goes on a narrow screen.
 *
 * The same node the workspace would have put in the right column, rendered at
 * the foot of the step instead. Hidden at xl, where the column exists.
 */
export function SideBelow({ children }: { children: ReactNode }) {
  if (!children) return null;
  // A phone does not get the panel at all — it repeated the card above it in a
  // second layout. A laptop without the column still gets it under the step.
  return <div className="mt-8 hidden border-t border-border/60 pt-6 md:block xl:hidden">{children}</div>;
}

export type StepRailItem = {
  id: string;
  label: string;
  /** Off the short path — Continue skips it; the manager opens it when they want to. */
  offPath?: boolean;
  /** Rooms, bathrooms, spaces, lease types — how many this step holds. */
  count?: number;
  /** Things the manager should look at before publishing. */
  attention?: number;
  /**
   * One line of what the section currently says — "2 rooms · 1 with photos",
   * "From $1,160 a month". The rail then reads as the listing's table of
   * contents rather than a list of chapter titles.
   */
  summary?: ReactNode;
};

/**
 * The step rail.
 *
 * Every step is reachable, always. The pill stepper this replaces disabled every
 * step past the one you were on, which is wrong for an EDIT: a manager opening a
 * live listing to change one room's rent should not have to walk four screens to
 * reach it.
 *
 * Each row is a summary card, the way Airbnb's listing editor lists "Title ·
 * House room in Jakarta" and "Pricing · Rp169,499 per night": the section's name
 * and, under it, what it currently says. A section that still needs something
 * carries a red dot before its name — no numbered circles, no ticks, because on
 * an edit those were claiming Rooms was "done" for having been earlier in the
 * list. The footer still counts the steps.
 */
export function StepRail({
  steps,
  current,
  onJump,
  visited,
}: {
  steps: readonly StepRailItem[];
  current: number;
  onJump: (index: number) => void;
  /** Steps the manager has already opened. Kept for callers; the rail no longer draws it. */
  visited?: ReadonlySet<string>;
}) {
  void visited;
  // On a phone the rail is a strip of chips; the one the manager is on must be
  // in view, or jumping to Pricing leaves the strip showing "Basics · Rooms".
  const currentRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // jsdom has no scrollIntoView; a test that jumps steps must not blow up on it.
    currentRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <ol className="flex gap-1 lg:flex-col lg:gap-1.5">
      {steps.map((step, i) => {
        const on = i === current;
        const warn = (step.attention ?? 0) > 0;
        return (
          <li key={step.id}>
            <button
              ref={on ? currentRef : undefined}
              type="button"
              onClick={() => onJump(i)}
              aria-current={on ? "step" : undefined}
              data-attr={`listing-v2-rail-${step.id}`}
              className={cn(
                "flex w-full shrink-0 items-start gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-left transition lg:py-2.5",
                on
                  ? "bg-white shadow-[0_0_0_1px_var(--pl-line-strong)] [html[data-theme=dark]_&]:bg-card"
                  : "hover:bg-foreground/[0.045]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {warn ? (
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--status-overdue-fg)]" aria-hidden />
                  ) : null}
                  <span
                    className={cn(
                      "min-w-0 truncate text-[13.5px]",
                      on ? "font-bold text-foreground" : "font-semibold text-foreground/80",
                    )}
                  >
                    {step.label}
                  </span>
                  {step.count != null ? (
                    <span className="hidden shrink-0 text-[12px] tabular-nums text-muted lg:inline">{step.count}</span>
                  ) : null}
                </span>
                {step.summary ? (
                  <span className="mt-0.5 hidden truncate text-[12px] leading-snug text-muted lg:block">{step.summary}</span>
                ) : null}
              </span>
              {warn ? <span className="sr-only">{step.attention} to look at</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The cover tile at the top of the rail.
 *
 * Turo's vehicle editor opens with the car's photo above the section list, and
 * it does the same job here: the manager can see at a glance which home they
 * have open, and a listing with no photo says so where it will be noticed.
 */
export function RailCover({
  photoUrl,
  photoCount,
  onAddPhotos,
}: {
  photoUrl: string | null;
  photoCount: number;
  /** Takes the manager to where photos are added. */
  onAddPhotos: () => void;
}) {
  return (
    <div className="mb-3">
      {photoUrl ? (
        <div className="relative overflow-hidden rounded-xl border border-border bg-accent/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="" className="block aspect-[16/10] w-full object-cover" />
          <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">
            {photoCount} {photoCount === 1 ? "photo" : "photos"}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onAddPhotos}
          data-attr="listing-v2-rail-add-photos"
          className="grid aspect-[16/10] w-full place-items-center rounded-xl border border-dashed border-border bg-white text-[12.5px] font-semibold text-muted transition hover:border-primary/50 hover:text-primary [html[data-theme=dark]_&]:bg-card"
        >
          <span className="flex flex-col items-center gap-1.5">
            <Camera className="h-5 w-5" strokeWidth={1.7} aria-hidden />
            Add photos
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * "Complete required steps" — the card Airbnb puts above the section list while
 * a listing still has gaps. One line, one action: it takes the manager to the
 * review, where every gap has its own Fix button.
 */
export function RailNotice({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-attr="listing-v2-rail-finish"
      className="mb-3 flex w-full items-center gap-2.5 rounded-xl border border-border bg-white px-3 py-2.5 text-left hover:bg-accent/30 [html[data-theme=dark]_&]:bg-card"
    >
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--status-overdue-fg)]" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold text-foreground">
          {count} {count === 1 ? "thing" : "things"} to finish
        </span>
      </span>
      <span aria-hidden className="text-muted">
        ›
      </span>
    </button>
  );
}

/**
 * The listing's status, at the foot of the rail.
 *
 * Turo states it under the section list — "Listed · Your car appears in search
 * results and can be booked" — and a manager editing a live home should never
 * have to wonder whether renters can see what they are changing.
 */
export function RailStatus({ listed }: { listed: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-white px-3 py-2.5 [html[data-theme=dark]_&]:bg-card">
      <span className="flex items-center gap-2 text-[13px] font-bold text-foreground">
        <span
          className={cn("h-2 w-2 rounded-full", listed ? "bg-[var(--status-confirmed-fg)]" : "border border-muted/60")}
          aria-hidden
        />
        {listed ? "Listed" : "Draft"}
      </span>
    </div>
  );
}

/* ─────────────────────────── side panel ─────────────────────────── */

/** A titled block in the right-hand panel. */
export function PanelSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">{title}</h3>
        {aside}
      </div>
      <div className="rounded-2xl border border-border bg-card p-3.5">{children}</div>
    </section>
  );
}

/** One labelled money line in the panel. */
export function PanelLine({
  label,
  note,
  amount,
  muted = false,
  control,
}: {
  label: ReactNode;
  note?: ReactNode;
  amount: ReactNode;
  /** Struck through — not collected at signing. */
  muted?: boolean;
  control?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-dashed border-border py-2 last:border-b-0">
      <span className="grid h-[18px] w-[18px] place-items-center">{control}</span>
      <span className="min-w-0 text-[13px] text-foreground">
        {label}
        {note ? <span className="block text-[11.5px] text-muted">{note}</span> : null}
      </span>
      <span className={cn("text-[13px] tabular-nums", muted ? "text-muted line-through" : "text-foreground")}>
        {amount}
      </span>
    </div>
  );
}

/** The heading block at the top of every step body. */
export function StepHeading({
  title,
  action,
}: {
  title: string;
  /** Small tertiary control — e.g. reset every row to the top defaults. */
  action?: ReactNode;
}) {
  /*
   * No "Step 3 of 6" here. The rail says where the manager is and the footer
   * counts the steps; a third copy in the body was the same fact three times on
   * one screen.
   */
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">{title}</h2>
      </div>
      {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
    </div>
  );
}

/**
 * A titled group of fields inside a step.
 *
 * Turo's editor breaks "Details" into "Your car", "Basic car details", "Vehicle
 * features": a bold subheading, a line of why, then the fields. It is what lets
 * a long form read as three short ones. Use it instead of a lone bold `<p>`.
 */
export function SectionGroup({
  title,
  children,
  first = false,
}: {
  title?: string;
  children: ReactNode;
  /** The first group sits directly under the step heading, without the top rule. */
  first?: boolean;
}) {
  return (
    <section className={cn(first ? "" : "mt-8 border-t border-border/60 pt-6")}>
      {title ? <h3 className="mb-4 text-[15.5px] font-bold tracking-tight text-foreground">{title}</h3> : null}
      {children}
    </section>
  );
}

/** Constrains a step body to a single readable column. */
/**
 * The body of a step.
 *
 * It used to cap at 520px inside a modal more than twice that wide, so most of
 * the screen was empty and a four-column row of short fields wrapped anyway.
 * The cap is now generous enough to use the modal and still keep a line of
 * prose readable; `wide` removes it for the table steps.
 */
export function StepColumn({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "w-full" : "w-full max-w-[860px]"}>{children}</div>;
}

/* ─────────────────────────── fields ─────────────────────────── */

export function Field({
  label,
  required,
  error,
  children,
  group = false,
  labelAside,
}: {
  label: string;
  required?: boolean;
  /** Shown only after a failed action — the one line of helper copy a field may carry. */
  error?: string;
  children: ReactNode;
  /** Sits after the label — the "Follows every room" / "This room · Reset" tag on a room field. */
  labelAside?: ReactNode;
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
      {labelAside ? <span className="ml-2 inline-flex align-middle font-normal">{labelAside}</span> : null}
    </>
  );
  const note = error ? <p className="mt-1.5 text-[12px] font-semibold text-red-600">{error}</p> : null;

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
  onSelect,
  dataAttr,
}: {
  selected: boolean;
  title: string;
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
        "mb-2.5 flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors",
        selected ? "border-primary bg-primary/5 ring-[3px] ring-primary/10" : "border-border bg-card hover:bg-accent/30",
      )}
    >
      <span
        className={cn(
          "h-[18px] w-[18px] shrink-0 rounded-full border-2 bg-card",
          selected ? "border-[5.5px] border-primary" : "border-border",
        )}
      />
      <b className="min-w-0 text-[13.5px] font-bold text-foreground">{title}</b>
    </button>
  );
}

/**
 * A choice as a tile: an icon, a name, a line of why.
 *
 * The property type used to be a select; Quick Add made it six cards, which
 * managers liked, so the editor draws it the same way. Compact enough that all
 * six fit on one row of a wide screen and two rows of a phone.
 */
export function KindTile({
  icon: Icon,
  label,
  selected,
  onSelect,
  dataAttr,
}: {
  icon: LucideIcon;
  label: string;
  selected: boolean;
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
        "flex min-h-[84px] w-full flex-col items-start justify-between gap-2 rounded-xl border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/[0.05] ring-[3px] ring-primary/10"
          : "border-border bg-card hover:border-foreground/25 hover:bg-accent/30",
      )}
    >
      <Icon className={cn("h-[22px] w-[22px]", selected ? "text-primary" : "text-muted")} strokeWidth={1.7} aria-hidden />
      <span className="block min-w-0 text-[13.5px] font-bold leading-tight text-foreground">{label}</span>
    </button>
  );
}

/**
 * A count with − and + on either side.
 *
 * A number of bedrooms is a thing you nudge, not a thing you pick from a list of
 * twenty; Airbnb and Turo both count this way and a manager never opens a select.
 */
export function CountStepper({
  value,
  min = 1,
  max = 20,
  step = 1,
  onChange,
  label,
  dataAttr,
  inherited = false,
  compact = false,
}: {
  value: number;
  min?: number;
  max?: number;
  /** Half steps for bathrooms (1, 1.5, 2 …). */
  step?: number;
  onChange: (next: number) => void;
  /** Read to assistive tech — the visible caption is the surrounding Field or FactRow. */
  label: string;
  dataAttr?: string;
  /** Following the "Every …" card: drawn dashed and grey until it becomes the record's own. */
  inherited?: boolean;
  /** The pill form a FactRow holds: one bordered capsule with − n + inside. */
  compact?: boolean;
}) {
  const round = (n: number) => Math.round(n * 100) / 100;
  const dec = () => onChange(Math.max(min, round(value - step)));
  const inc = () => onChange(Math.min(max, round(value + step)));
  if (compact) {
    const side = "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[17px] leading-none text-foreground transition hover:bg-foreground/[0.06] disabled:opacity-35 disabled:hover:bg-transparent";
    return (
      <div
        className={cn(
          "inline-flex h-9 items-center gap-1 rounded-full border bg-card px-1",
          inherited ? "border-dashed border-border text-muted" : "border-border",
        )}
        data-attr={dataAttr}
        role="group"
        aria-label={label}
      >
        <button type="button" className={side} aria-label={`Fewer ${label}`} disabled={value <= min} onClick={dec}>−</button>
        <span className={cn("min-w-[2.5ch] text-center text-[14px] font-bold tabular-nums", inherited ? "text-muted" : "text-foreground")} aria-live="polite">{value}</span>
        <button type="button" className={side} aria-label={`More ${label}`} disabled={value >= max} onClick={inc}>+</button>
      </div>
    );
  }
  const btn =
    "grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-[18px] leading-none text-foreground transition hover:bg-accent/40 disabled:opacity-35 disabled:hover:bg-card";
  return (
    <div className="inline-flex items-center gap-3" data-attr={dataAttr}>
      <button type="button" className={btn} aria-label={`Fewer ${label}`} disabled={value <= min} onClick={dec}>
        −
      </button>
      <span className="min-w-[2ch] text-center text-[16px] font-bold tabular-nums text-foreground" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} aria-label={`More ${label}`} disabled={value >= max} onClick={inc}>
        +
      </button>
    </div>
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
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-accent/25 px-4 py-3 text-left transition hover:bg-accent/40"
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-bold text-foreground">{open ? "Hide extra options" : "More options"}</span>
          <span className="mt-0.5 block truncate text-[12px] text-muted">{label}</span>
        </span>
        <span className="shrink-0 text-[13px] font-bold text-primary" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div className="mt-4 rounded-xl border border-border bg-accent/15 p-4">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * One Advanced panel holding named groups, used at both house and room level.
 *
 * Two "More options" cards asking a manager to guess which one held the late
 * fee was the thing being fixed. There is one panel now, and inside it the
 * groups are named for what a manager is looking for — Lease terms, Payments,
 * Media, Move-in — so finding a field is reading a list rather than opening
 * boxes.
 */
export function AdvancedPanel({
  summary,
  open,
  onToggle,
  children,
  dataAttr,
}: {
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-accent/15">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-attr={dataAttr}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition hover:bg-accent/30"
      >
        <span className="block min-w-0 truncate text-[14px] font-bold leading-5 text-foreground no-underline">{summary}</span>
        <span className="shrink-0 text-[13px] font-bold text-primary" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? <div className="border-t border-border bg-card">{children}</div> : null}
    </div>
  );
}

/**
 * A named group inside {@link AdvancedPanel}. Closed until asked for, so the
 * panel opens onto a readable list of names rather than a wall of fields.
 */
export function AdvancedGroup({
  title,
  open,
  onToggle,
  children,
  dataAttr,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-attr={dataAttr}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-accent/20"
      >
        {/*
         * `no-underline` and an explicit line box: the description sits inside a
         * <button>, and the decoration a button can inherit was drawing short
         * rules through the middle of words like "move-in".
         */}
        <span className="block min-w-0 text-[13.5px] font-bold leading-5 text-foreground no-underline">{title}</span>
        <span className="shrink-0 text-[12px] font-bold text-primary" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? <div className="border-t border-border/60 bg-accent/10 px-4 pb-5 pt-4">{children}</div> : null}
    </div>
  );
}

/* ─────────────────────────── yes / no ─────────────────────────── */

/**
 * A checkbox with its label and a line of explanation.
 *
 * Replaces the pill toggles for anything that is genuinely a yes/no: a pill
 * that fills in when pressed reads as a button you clicked, not as a box you
 * ticked, and a manager could not tell "Move-in checklist required" ON from the
 * same words sitting there unpressed.
 */
export function CheckboxOption({
  label,
  checked,
  onChange,
  dataAttr,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  dataAttr?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        data-attr={dataAttr}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded border-border"
      />
      <span className="min-w-0 text-[13px] font-semibold text-foreground">{label}</span>
    </label>
  );
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

/**
 * The ↺ inside a grid cell that holds its own value: one click puts THAT field
 * back on the "Every …" row. Absolutely positioned so it sits inside the cell's
 * box without being a child of the cell's own button (a button in a button is
 * not HTML); the cell pads its right edge to keep text clear of it.
 */
export function CellResetButton({
  label,
  onClick,
  className,
  dataAttr = "listing-v2-cell-reset",
}: {
  label: string;
  onClick: () => void;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Back to the top row"
      data-attr={dataAttr}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "absolute top-1/2 z-[1] grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      <RotateCcw className="h-3 w-3" aria-hidden />
    </button>
  );
}

/**
 * A dropdown inside a grid row — floor, bathroom access, residents, pricing
 * mode. The PropLane field dropdown at cell size: same height and radius as
 * the text inputs beside it, the shared white menu instead of the OS picker.
 * With `onReset`, a cell that is the row's own shows the ↺ left of the chevron.
 */
export function RowSelectCell({
  value,
  options,
  placeholder,
  inherited,
  disabled,
  onChange,
  onReset,
  resetLabel,
  ariaLabel,
  className,
  dataAttr,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
  inherited?: boolean;
  disabled?: boolean;
  onChange: (next: string) => void;
  /** Put this one field back on the top row; the ↺ renders only while the cell is not `inherited`. */
  onReset?: () => void;
  resetLabel?: string;
  ariaLabel: string;
  className?: string;
  dataAttr?: string;
}) {
  const showReset = Boolean(onReset) && !inherited && !disabled;
  return (
    <span className={cn("relative block min-w-0", className)}>
      <FieldSingleSelect
        variant="cell"
        hideLabel
        label={ariaLabel}
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
        placeholder={placeholder ?? "Select…"}
        inherited={inherited}
        disabled={disabled}
        dataAttr={dataAttr}
        wrapperClassName="min-w-0"
        /* The chevron stays at the edge; the value text stops short of the ↺ overlaid left of it. */
        valueClassName={showReset ? "pr-5" : undefined}
      />
      {showReset ? <CellResetButton label={resetLabel ?? `Reset ${ariaLabel} to the top row`} onClick={onReset!} className="right-7" /> : null}
    </span>
  );
}

/** The floating bar shown while rows are selected. */
/**
 * The floating bar shown while rows are selected.
 *
 * No count label: the selection is already visible in the rows themselves, and
 * the portal's own bulk bars are `hideCount` for exactly that reason. The bar
 * carries actions only.
 */
export function RowBulkBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-full border border-border bg-card px-2 py-2 shadow-[0_10px_28px_-14px_rgba(11,27,58,0.4)]">
      {children}
    </div>
  );
}

export function BulkButton({
  onClick,
  children,
  tone = "default",
}: {
  onClick: () => void;
  children: ReactNode;
  /** `danger` is text-only red, per the design system — never a filled red button. */
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-4 py-2 text-[12.5px] font-bold transition",
        tone === "primary" && "bg-primary text-white hover:brightness-110",
        tone === "default" && "border border-border bg-card text-foreground hover:bg-accent/50",
        tone === "danger" && "text-red-700 hover:bg-red-50",
      )}
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

/* ─────────────────────────── record cards ─────────────────────────── */

/**
 * The card a room, bathroom, shared space, fee or bundle is.
 *
 * It replaces the sideways-scrolling grids. A card is a name (or a title), one
 * summary line, and a chevron; open, it unfolds its rows in place, full width,
 * so the same layout serves a 390px phone and the website. `every` is the
 * defaults card — "Every room" — drawn on the blue tint the old top row had.
 */
export function RecordCard({
  title,
  name,
  onName,
  namePlaceholder,
  nameLabel,
  summary,
  open,
  onToggle,
  toggleLabel,
  every = false,
  dimmed = false,
  dataAttr,
  children,
  rows,
  help,
  same,
  onDuplicate,
  duplicateLabel,
  onRemove,
  removeLabel,
}: {
  /** A fixed title ("Default room"); use `name`/`onName` for a typed one instead. */
  title?: ReactNode;
  /** The ⓘ beside the title — the one place the card is explained. */
  help?: string;
  /** The "Same as default room" line under the name. */
  same?: ReactNode;
  /** Labeled Duplicate, left of ✕. Hidden on Default cards by not passing this. */
  onDuplicate?: () => void;
  duplicateLabel?: string;
  /** The ✕ in the header that removes the record. */
  onRemove?: () => void;
  removeLabel?: string;
  name?: string;
  onName?: (next: string) => void;
  namePlaceholder?: string;
  nameLabel?: string;
  summary?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  every?: boolean;
  /** "Same as long-term" on another lease type — visible, not editable. */
  dimmed?: boolean;
  dataAttr?: string;
  /** What unfolds when the card is open. */
  children?: ReactNode;
  /** Rows that are always visible (the defaults card's controls). */
  rows?: ReactNode;
}) {
  return (
    <div
      data-attr={dataAttr}
      className={cn(
        "mb-2.5 rounded-2xl border border-border bg-card",
        every && "border-b-2 border-b-primary/25 bg-primary/[0.04]",
        open && "shadow-[inset_3px_0_0_var(--pl-blue)]",
        dimmed && "pointer-events-none opacity-50",
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          {onName != null ? (
            <input
              aria-label={nameLabel ?? "Name"}
              value={name ?? ""}
              placeholder={namePlaceholder}
              onChange={(e) => onName(e.target.value)}
              className="min-h-[38px] w-full min-w-0 rounded-xl border border-border bg-card px-3 text-[14px] font-bold text-foreground outline-none focus:border-primary"
            />
          ) : (
            <b className="flex min-w-0 items-center gap-1.5 text-[14px] font-bold text-foreground">
              {title ?? name}
              {help ? <ColumnHelp title={typeof title === "string" ? title : "This"} text={help} dataAttr="listing-v2-defaults-help" /> : null}
            </b>
          )}
          {same}
        </span>
        {onDuplicate ? (
          <button
            type="button"
            onClick={onDuplicate}
            aria-label={duplicateLabel ?? `Duplicate ${toggleLabel ?? name ?? "this"}`}
            data-attr={dataAttr ? `${dataAttr}-duplicate` : "listing-v2-card-duplicate"}
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-md border border-border px-2.5 text-[12px] font-bold text-primary hover:bg-foreground/[0.06]"
          >
            Duplicate
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={removeLabel ?? `Remove ${toggleLabel ?? name ?? "this"}`}
            data-attr={dataAttr ? `${dataAttr}-remove` : "listing-v2-card-remove"}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground"
          >
            ✕
          </button>
        ) : null}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Close" : "Open"} ${toggleLabel ?? name ?? "card"}`}
            data-attr={every ? undefined : "listing-v2-card-open"}
            className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground", open && "text-primary")}
          >
            <ChevronRight className={cn("h-5 w-5 transition-transform", open && "rotate-90")} aria-hidden />
          </button>
        ) : null}
      </div>
      {summary != null && onToggle ? (
        <button type="button" onClick={onToggle} className="block w-full px-3.5 pb-3 text-left text-[13px] leading-snug text-foreground/70">
          {summary}
        </button>
      ) : summary != null ? (
        <p className="px-3.5 pb-3 text-[13px] leading-snug text-foreground/70">{summary}</p>
      ) : null}
      {rows}
      {open ? <div className="border-t border-border">{children}</div> : null}
    </div>
  );
}

/**
 * One row of a card: the label on the left, the control on the right.
 *
 * `own` marks a value the record set itself (a Reset puts it back on the
 * "Every …" card); `sub` indents a row that belongs to the one above it, the
 * way Beds and Included belong to Furnishing.
 */
export function FactRow({
  label,
  children,
  own,
  onReset,
  resetLabel,
  sub = false,
  first = false,
  required = false,
}: {
  label: ReactNode;
  children: ReactNode;
  own?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  sub?: boolean;
  first?: boolean;
  required?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center justify-between gap-3 px-3.5 py-2",
        !first && "border-t border-border",
        sub && "bg-foreground/[0.025] pl-7",
      )}
    >
      <span className={cn("flex min-w-0 shrink items-center gap-2 text-[14px] text-foreground", sub ? "font-medium" : "font-semibold")}>
        <span className="truncate">
          {label}
          {required ? <span className="ml-0.5 text-red-600">*</span> : null}
        </span>
        {own && onReset ? (
          <button
            type="button"
            onClick={onReset}
            data-attr="listing-v2-cell-reset"
            aria-label={resetLabel ?? `Reset ${typeof label === "string" ? label : "this"} to the top card`}
            title="Back to the Default card"
            className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-[var(--status-approved-fg)] hover:underline"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
            Reset
          </button>
        ) : null}
      </span>
      <span className="flex min-w-0 shrink-0 items-center justify-end">{children}</span>
    </div>
  );
}

/** A block of stacked fields inside an open card (photos, description…). */
export function CardFields({ children, cols = 1 }: { children: ReactNode; cols?: 1 | 2 }) {
  // Two columns at every width: photos and video sit side by side on a phone too.
  return <div className={cn("grid gap-x-4 px-3.5 pt-3", cols === 2 && "grid-cols-2")}>{children}</div>;
}

/** The actions at the foot of an open card. */
export function CardFoot({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1.5 border-t border-border px-3.5 py-2.5">{children}</div>;
}

export function CardAction({
  onClick,
  tone = "default",
  dataAttr,
  children,
}: {
  onClick: () => void;
  tone?: "default" | "danger" | "primary";
  dataAttr?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-attr={dataAttr}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-[12.5px] font-bold transition",
        tone === "default" && "text-muted hover:bg-foreground/[0.05] hover:text-foreground",
        tone === "danger" && "text-[var(--status-overdue-fg)] hover:bg-[var(--status-overdue-bg)]",
        tone === "primary" && "bg-primary text-white hover:brightness-110",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Pick several from a list, at cell size, with an "Other…" box at the foot of
 * the menu for anything the list lacks.
 *
 * This is the one control for every pick-several field in the wizard —
 * what a furnished room includes, a room's amenities, a bathroom's finishes,
 * the house's amenities. No chips: the row reads "Bed, Desk +2" and the menu
 * ticks. Custom values a manager typed become options so they stay ticked.
 */
export function MultiPick({
  label,
  options,
  selected,
  onChange,
  inherited = false,
  emptyLabel = "None",
  allowOther = true,
  dataAttr,
}: {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  inherited?: boolean;
  emptyLabel?: string;
  allowOther?: boolean;
  dataAttr?: string;
}) {
  const [other, setOther] = useState("");
  const custom = selected.filter((s) => !options.includes(s));
  const all = [...options, ...custom];
  const summary =
    selected.length === 0
      ? emptyLabel
      : selected.length <= 2
        ? selected.join(", ")
        : `${selected.slice(0, 2).join(", ")} +${selected.length - 2}`;
  const add = () => {
    const value = other.trim();
    if (!value) return;
    setOther("");
    if (selected.includes(value)) return;
    onChange([...selected, value]);
  };
  return (
    <CheckboxMultiSelect
      hideLabel
      label={label}
      dataAttr={dataAttr}
      variant="cell"
      className={cn("min-w-[150px] max-w-[220px]", inherited && "border-dashed text-muted")}
      options={all.map((o) => ({ value: o, label: o }))}
      selected={[...selected]}
      selectionTriggerLabel={summary}
      emptyLabel={emptyLabel}
      onChange={(next) => onChange(next)}
      menuFooter={
        allowOther ? (
          <div className="border-t border-border px-3 py-2" onPointerDown={(e) => e.stopPropagation()}>
            <input
              value={other}
              aria-label={`Other ${label}`}
              placeholder="Other — type and press Enter"
              className="min-h-[34px] w-full rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground outline-none focus:border-primary"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              onBlur={add}
            />
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * A money input at cell size — `$` inside, dashed while it follows the Default card.
 *
 * While it has focus it shows what was typed, not what the model echoes back:
 * the model rounds "1,1" to a number and re-renders the string, and on iOS
 * that rewrite lands the caret in front of the digits (typing 3 into 1650
 * gave 31650) or, when the round trip is lost, shows nothing at all. Every
 * keystroke still reaches `onChange`; blur commits once more and lets the
 * model's formatting win.
 */
export function MoneyInput({
  value,
  onChange,
  label,
  placeholder,
  inherited = false,
  dataAttr,
}: {
  value: string;
  onChange: (raw: string) => void;
  label: string;
  placeholder?: string;
  inherited?: boolean;
  dataAttr?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="relative inline-block w-[118px]">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-muted">$</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        aria-label={label}
        value={draft ?? value}
        placeholder={placeholder}
        data-attr={dataAttr}
        onFocus={() => setDraft(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => {
          if (draft !== null && draft !== value) onChange(draft);
          setDraft(null);
        }}
        className={cn(
          "min-h-[36px] w-full rounded-lg border bg-card pl-5 pr-2.5 text-right text-[13.5px] font-semibold tabular-nums text-foreground outline-none focus:border-primary",
          inherited ? "border-dashed border-border text-muted placeholder:text-muted" : "border-border",
        )}
      />
    </span>
  );
}


/* ───────────── the "All …" pattern: help, same-as-all, more, done ───────────── */

/**
 * The ⓘ beside a label or a card title. One tap says what the thing means;
 * the screen itself carries no caption text. One popover is open at a time
 * and it closes on outside click or Escape.
 */
export function ColumnHelp({ title, text, dataAttr }: { title: string; text: string; dataAttr?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`What ${title} means`}
        aria-expanded={open}
        data-attr={dataAttr ?? "listing-v2-column-help"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "grid h-[15px] w-[15px] place-items-center rounded-full border text-[9.5px] font-extrabold normal-case tracking-normal transition-colors",
          open ? "border-primary text-primary" : "border-current text-muted hover:border-primary hover:text-primary",
        )}
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1.5 w-[272px] max-w-[80vw] rounded-xl bg-foreground px-3 py-2.5 text-left text-[12.5px] font-medium normal-case leading-relaxed tracking-normal text-white shadow-lg"
        >
          <b className="mb-0.5 block font-extrabold">{title}</b>
          {text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The line under a card's name: ☑ Same as default room / ☐ This room only · ↺ Reset.
 *
 * Ticked means every field on the card copies the "Default …" card (the
 * Rooms step's own top card reads "All rooms" — pass `allLabel` to name it).
 * Unticking changes nothing yet — the whole record becomes its own on
 * purpose; changing one field makes only that field its own. Reset (or
 * ticking again) copies the "Default …" card back.
 */
export function SameAsAllToggle({
  same,
  noun,
  allLabel,
  onChange,
  onReset,
  dataAttr,
}: {
  same: boolean;
  noun: string;
  /** What the ticked line names the top card as — "default room" by default, or e.g. "all rooms". */
  allLabel?: string;
  onChange: (same: boolean) => void;
  onReset: () => void;
  dataAttr?: string;
}) {
  return (
    <label className={cn("mt-1.5 flex cursor-pointer select-none items-center gap-1.5 text-[12px] font-semibold", same ? "text-muted" : "text-primary")}>
      <input
        type="checkbox"
        checked={same}
        data-attr={dataAttr ?? "listing-v2-same-as-all"}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--pl-blue)]"
      />
      {same ? (
        <span>Same as {allLabel ?? `default ${noun}`}</span>
      ) : (
        <span>
          This {noun} only ·{" "}
          <button
            type="button"
            data-attr="listing-v2-make-same"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onReset();
            }}
            className="font-bold hover:underline"
          >
            ↺ Reset
          </button>
        </span>
      )}
    </label>
  );
}

/**
 * The More ▾ under a card's important rows. Everything else lives behind it,
 * and one press shows it all — there is no second More inside.
 */
export function MoreRows({ children, dataAttr }: { children: ReactNode; dataAttr?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="border-t border-border px-3.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-attr={dataAttr ?? "listing-v2-more"}
          className="text-[13px] font-bold text-primary hover:underline"
        >
          {open ? "Less ▴" : "More ▾"}
        </button>
      </div>
      {open ? children : null}
    </>
  );
}

/**
 * The one closer at the foot of an open card.
 *
 * Brand blue, like every primary button in the product — it was the only
 * black filled control on the screen (the captain's "wrong color", 2026-09-15).
 */
export function EditorDone({ onClick, dataAttr }: { onClick: () => void; dataAttr?: string }) {
  return (
    <div className="flex justify-end border-t border-border px-3.5 py-3">
      <button type="button" onClick={onClick} data-attr={dataAttr ?? "listing-v2-editor-done"} className="rounded-full bg-primary px-4 py-1.5 text-[12.5px] font-bold text-white shadow-[0_8px_20px_-8px_color-mix(in_srgb,var(--pl-blue)_60%,transparent)] hover:brightness-110">
        Done
      </button>
    </div>
  );
}
