"use client";

/**
 * Building blocks shared by every add-workspace door.
 *
 * Everything here follows the portal UI rules: no grey helper sentences under
 * fields, picks are dropdowns (`FieldSingleSelect` / `CheckboxMultiSelect`),
 * counts are steppers. A hint that must exist lives in a header chip or in the
 * side panel, never as subtext.
 */

import { useRef, useState, type ReactNode } from "react";
import { Upload, FileText, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";

/* ─────────────────────────── layout ─────────────────────────── */

/** A bordered group inside a step — title on the rail, fields in the body. */
export function WizardSection({
  title,
  chip,
  children,
  className,
  dataAttr,
}: {
  title: string;
  chip?: ReactNode;
  children: ReactNode;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <section data-attr={dataAttr} className={cn("mb-4 overflow-hidden rounded-2xl border border-border bg-card", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h3 className="text-[14px] font-bold tracking-tight text-foreground">{title}</h3>
        {chip ? <span className="shrink-0">{chip}</span> : null}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

export function WizardChip({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold",
        tone === "info" && "bg-primary/[0.08] text-[var(--pl-blue-deep)]",
        tone === "ok" && "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
        tone === "warn" && "bg-[var(--status-pending-bg,#fdf0d5)] text-[var(--status-pending-fg,#a34a06)]",
      )}
    >
      {children}
    </span>
  );
}

/** Two or three labelled controls on one line. */
export function WizardRow({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}

/** A labelled field. The label may carry a mark ("from file") after it. */
export function WizardField({
  label,
  required,
  mark,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  mark?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-bold text-foreground">
        {label}
        {required ? <span className="text-red-600">*</span> : null}
        {mark ? <span className="ml-1 inline-flex font-normal">{mark}</span> : null}
      </span>
      {children}
    </label>
  );
}

/** A one-line row inside a section: bold label left, a control right. */
export function WizardLine({ label, control, chip }: { label: ReactNode; control?: ReactNode; chip?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-3 first:pt-0 last:border-b-0 last:pb-0">
      <span className="min-w-0 text-[14px] font-semibold text-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        {chip}
        {control}
      </span>
    </div>
  );
}

/** "from file" / "check" — the mark a parsed value carries until the manager touches it. */
export function FieldMark({ kind }: { kind: "fromFile" | "check" | null | undefined }) {
  if (!kind) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[10.5px] font-bold",
        kind === "fromFile" ? "bg-primary/[0.08] text-[var(--pl-blue-deep)]" : "bg-[#fdf0d5] text-[#a34a06]",
      )}
    >
      {kind === "fromFile" ? "from file" : "check"}
    </span>
  );
}

/** A count control — the portal draws counts as steppers, never inputs. */
export function WizardStepper({
  value,
  onChange,
  min = 0,
  max = 20,
  label,
  dataAttr,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  label: string;
  dataAttr?: string;
}) {
  return (
    <span className="inline-flex h-10 items-center overflow-hidden rounded-full border border-border" role="group" aria-label={label} data-attr={dataAttr}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={`Fewer ${label}`}
        className="grid h-full w-9 place-items-center text-muted disabled:opacity-40"
      >
        −
      </button>
      <span className="min-w-[2.25rem] text-center text-[14px] font-bold tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`More ${label}`}
        className="grid h-full w-9 place-items-center text-muted disabled:opacity-40"
      >
        +
      </button>
    </span>
  );
}

/* ─────────────────────────── files ─────────────────────────── */

export type FileStripState =
  | { kind: "blank" }
  | { kind: "reading"; fileName: string }
  | { kind: "read"; summary: string; canUndo: boolean };

/**
 * "Start from a file" — the strip under a step heading that reads a PDF or
 * image and fills what it can. The same look as Create listing's strip.
 */
export function FileStartStrip({
  state,
  chips,
  accept,
  onPick,
  onUndo,
  disabled,
  dataAttr = "add-file-strip",
  title = "Start from a file",
}: {
  state: FileStripState;
  chips: readonly string[];
  accept: string;
  onPick: (file: File) => void;
  onUndo?: () => void;
  disabled?: boolean;
  dataAttr?: string;
  title?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onPick(file);
    if (fileRef.current) fileRef.current.value = "";
  };
  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={accept}
      className="sr-only"
      onChange={(e) => pick(e.target.files)}
      data-attr={`${dataAttr}-input`}
      aria-label={title}
    />
  );
  if (state.kind === "reading") {
    return (
      <div data-attr={dataAttr} data-state="reading" className="mb-5 flex items-center gap-3.5 rounded-2xl border-[1.5px] border-primary bg-card px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-card text-[var(--pl-blue-deep)]">
          <Upload className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-bold text-foreground" role="status">
            Reading {state.fileName}
          </span>
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-accent" aria-hidden>
            <span className="block h-full w-1/3 animate-[add-file-read_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
          </span>
          <style>{`@keyframes add-file-read { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
        </span>
      </div>
    );
  }
  if (state.kind === "read") {
    return (
      <div data-attr={dataAttr} data-state="read" className="mb-5 flex flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-primary/40 bg-primary/[0.06] px-4 py-3 sm:flex-nowrap">
        {input}
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-white">
          <Upload className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold text-foreground">Filled from your file — check the marked fields</span>
          <span className="mt-1 block truncate text-[12px] font-semibold text-muted">{state.summary}</span>
        </span>
        <span className="flex w-full items-center gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            data-attr={`${dataAttr}-another`}
            className="min-h-[40px] rounded-full border border-border bg-card px-4 text-[13px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50"
          >
            Add another
          </button>
          {state.canUndo && onUndo ? (
            <button
              type="button"
              onClick={onUndo}
              data-attr={`${dataAttr}-undo`}
              className="min-h-[40px] rounded-full px-3 text-[13px] font-bold text-primary"
            >
              Undo fill
            </button>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        pick(e.dataTransfer.files);
      }}
      data-attr={dataAttr}
      data-state="blank"
      className={cn(
        "mb-5 flex cursor-pointer flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed px-4 py-3 transition sm:flex-nowrap",
        dragOver ? "border-primary bg-primary/[0.06]" : "border-border bg-[var(--pl-surface-muted)] hover:border-primary/50",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      {input}
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-card text-[var(--pl-blue-deep)]">
        <Upload className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-foreground">{title}</span>
        <span className="mt-1 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span key={chip} className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-bold text-muted">
              {chip}
            </span>
          ))}
        </span>
      </span>
      <span className="w-full sm:w-auto">
        <span className="inline-flex min-h-[40px] w-full items-center justify-center rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground sm:w-auto">
          Choose file
        </span>
      </span>
    </label>
  );
}

export type AttachedDocument = {
  id: string;
  file: File;
  kind: string;
  /** What reading it filled — "read · filled Contact + Application". */
  note?: string;
};

/** One attached file with its kind picker and a remove control. */
export function DocumentRow({
  doc,
  kinds,
  onKind,
  onRemove,
  badge,
}: {
  doc: AttachedDocument;
  kinds: { value: string; label: string }[];
  onKind: (kind: string) => void;
  onRemove: () => void;
  badge?: ReactNode;
}) {
  const isImage = doc.file.type.startsWith("image/");
  const size = doc.file.size > 1024 * 1024 ? `${(doc.file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(doc.file.size / 1024))} KB`;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border/60 py-3 first:pt-0 last:border-b-0 last:pb-0 sm:flex-nowrap">
      <span className="grid h-11 w-9 shrink-0 place-items-center rounded-md bg-primary/[0.08] text-[var(--pl-blue-deep)]">
        {isImage ? <ImageIcon className="h-4 w-4" aria-hidden /> : <FileText className="h-4 w-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-foreground">{doc.file.name}</span>
        <span className="block truncate text-[12px] text-muted">
          {size}
          {doc.note ? ` · ${doc.note}` : ""}
        </span>
      </span>
      {badge}
      <span className="w-full sm:w-[200px]">
        <FieldSingleSelect label="Document kind" hideLabel value={doc.kind} onChange={onKind} options={kinds} variant="cell" />
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${doc.file.name}`}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-accent/50"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** The dashed "+ Add …" footer at the foot of a list. */
export function AddFoot({ label, onClick, dataAttr }: { label: string; onClick: () => void; dataAttr?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-attr={dataAttr}
      className="mt-3 w-full rounded-xl border-[1.5px] border-dashed border-border px-3 py-3 text-center text-[13.5px] font-bold text-primary hover:border-primary/50"
    >
      {label}
    </button>
  );
}

/* ─────────────────────────── review + side panel ─────────────────────────── */

export type ReviewFact = { label: string; value: ReactNode; missing?: boolean };

/** One section on the Review step: badge, Edit, and its facts. */
export function ReviewCard({
  title,
  status,
  onEdit,
  facts,
  dataAttr,
}: {
  title: string;
  status: "complete" | "incomplete" | "optional";
  onEdit: () => void;
  facts: ReviewFact[];
  dataAttr?: string;
}) {
  return (
    <section data-attr={dataAttr} className="mb-3 overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h3 className="text-[14px] font-bold text-foreground">{title}</h3>
        <span className="flex items-center gap-2.5">
          <WizardChip tone={status === "complete" ? "ok" : status === "incomplete" ? "warn" : "ok"}>
            {status === "complete" ? "Complete" : status === "incomplete" ? "Incomplete" : "Optional"}
          </WizardChip>
          <button type="button" onClick={onEdit} className="text-[13px] font-bold text-primary">
            Edit
          </button>
        </span>
      </div>
      <div className="grid gap-x-4 gap-y-2 px-4 py-3 text-[13.5px] sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <span className="block text-[12px] text-muted">{f.label}</span>
            <span className={cn("block font-semibold", f.missing ? "text-red-600" : "text-foreground")}>{f.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export type CreatesItem = { tone: "yes" | "no" | "warn"; text: ReactNode };

/** The side panel: who this is and what adding them creates. */
export function PreviewPanel({
  title,
  name,
  sub,
  facts,
  creates,
}: {
  title: string;
  name: ReactNode;
  sub?: ReactNode;
  facts: { label: string; value: ReactNode; warn?: boolean }[];
  creates: CreatesItem[];
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">{title}</h3>
      <div className="rounded-2xl border border-border bg-card p-3.5">
        <div className="text-[15px] font-bold text-foreground">{name}</div>
        {sub ? <div className="text-[12.5px] text-muted">{sub}</div> : null}
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <span className="block text-[11.5px] text-muted">{f.label}</span>
              <span className={cn("block font-bold", f.warn ? "text-[#a34a06]" : "text-foreground")}>{f.value}</span>
            </div>
          ))}
        </div>
        <div className="mt-3.5 border-t border-border/60 pt-3">
          <h4 className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">This will create</h4>
          {creates.map((c, i) => (
            <div key={i} className="flex items-start gap-2 py-1 text-[13px] text-foreground">
              <span
                className={cn(
                  "mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[11px] font-black",
                  c.tone === "yes" && "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
                  c.tone === "no" && "bg-accent text-muted",
                  c.tone === "warn" && "bg-[#fdf0d5] text-[#a34a06]",
                )}
                aria-hidden
              >
                {c.tone === "yes" ? "✓" : c.tone === "warn" ? "!" : "–"}
              </span>
              <span>{c.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── the closing message ─────────────────────────── */

export type MessageChannel = "email" | "sms" | "link" | "none";

export type MessageDraft = {
  channels: MessageChannel[];
  subject: string;
  body: string;
};

export const MESSAGE_CHANNEL_OPTIONS: { value: MessageChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
  { value: "link", label: "Copy a link" },
  { value: "none", label: "No message" },
];

/** Keeps "No message" exclusive of the others. */
export function normalizeMessageChannels(next: string[], previous: MessageChannel[]): MessageChannel[] {
  const picked = next.filter((v): v is MessageChannel => v === "email" || v === "sms" || v === "link" || v === "none");
  const addedNone = picked.includes("none") && !previous.includes("none");
  if (addedNone) return ["none"];
  const withoutNone = picked.filter((v) => v !== "none");
  return withoutNone.length ? withoutNone : previous.includes("none") ? [] : ["none"];
}

/**
 * "Message the …" — the last section of every door's Review step. Channels
 * are a multi-select; the subject and body are editable here and previewed
 * once more by the notification modal before anything sends.
 */
export function MessageStep({
  who,
  draft,
  onChange,
  emailAvailable,
  smsAvailable,
  linkLabel = "Copy a link",
  dataAttr = "add-message",
}: {
  who: string;
  draft: MessageDraft;
  onChange: (next: MessageDraft) => void;
  emailAvailable: boolean;
  smsAvailable: boolean;
  linkLabel?: string;
  dataAttr?: string;
}) {
  const options = MESSAGE_CHANNEL_OPTIONS.map((o) => ({
    ...o,
    label: o.value === "link" ? linkLabel : o.label,
    disabled: (o.value === "email" && !emailAvailable) || (o.value === "sms" && !smsAvailable),
    hint: o.value === "email" && !emailAvailable ? "no email" : o.value === "sms" && !smsAvailable ? "no phone" : undefined,
  }));
  const quiet = draft.channels.includes("none") || draft.channels.length === 0 || (draft.channels.length === 1 && draft.channels[0] === "link");
  return (
    <WizardSection title={`Message the ${who}`} chip={<WizardChip>previewed before it sends</WizardChip>} dataAttr={dataAttr}>
      <WizardRow cols={2}>
        <CheckboxMultiSelect
          label="Send by"
          options={options}
          selected={draft.channels}
          onChange={(next) => onChange({ ...draft, channels: normalizeMessageChannels(next, draft.channels) })}
          dataAttr={`${dataAttr}-channels`}
          emptyLabel="Select…"
        />
        <FieldSingleSelect
          label="When"
          value="now"
          onChange={() => undefined}
          options={[{ value: "now", label: "Right after adding" }]}
          dataAttr={`${dataAttr}-when`}
        />
      </WizardRow>
      {!quiet ? (
        <div className="mt-3 grid gap-3">
          <WizardField label="Subject">
            <Input value={draft.subject} onChange={(e) => onChange({ ...draft, subject: e.target.value })} data-attr={`${dataAttr}-subject`} />
          </WizardField>
          <WizardField label="Message">
            <Textarea className="min-h-[120px]" value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} data-attr={`${dataAttr}-body`} />
          </WizardField>
        </div>
      ) : null}
    </WizardSection>
  );
}
