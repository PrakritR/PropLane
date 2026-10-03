import type { ReactNode } from "react";

/** Previews receive the same controlled draft or server amounts as the committing action. */
export function PopupRecordPreview({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm" data-attr="popup-record-preview">
    {rows.map(row => <div key={row.label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3"><dt className="text-muted">{row.label}</dt><dd className="min-w-0 break-words font-semibold">{row.value == null || row.value === "" ? "Not set" : row.value}</dd></div>)}
  </dl>;
}

export function PopupMessagePreview({ subject, body, recipient, channel, sendAt }: { subject?: string; body: string; recipient?: string; channel?: string; sendAt?: string }) {
  return <article className="overflow-hidden rounded-xl border border-border bg-card" data-attr="popup-message-preview">
    <div className="space-y-2 border-b border-border p-4">
      {subject != null ? <h4 className="font-semibold">{subject || "No subject"}</h4> : null}
      {recipient ? <div className="break-words text-sm"><span className="text-muted">To: </span>{recipient}</div> : null}
      {channel ? <div className="text-xs text-muted">{channel}</div> : null}
      {sendAt ? <time className="block text-xs text-muted">{sendAt}</time> : null}
    </div>
    <div className="whitespace-pre-wrap break-words p-4 text-sm">{body || "No message"}</div>
  </article>;
}

/** A review as the vendor's profile will show it: the stars and the words, as typed. */
export function PopupReviewPreview({ stars, body, subject }: { stars: number; body: string; subject?: string }) {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return <article className="overflow-hidden rounded-xl border border-border bg-card" data-attr="popup-review-preview">
    <div className="space-y-1 border-b border-border p-4">
      {subject ? <p className="text-xs text-muted">{subject}</p> : null}
      <p className="text-lg tracking-wide text-amber-500" role="img" aria-label={`${n} of 5 stars`}>{"★".repeat(n)}<span className="text-border">{"★".repeat(5 - n)}</span></p>
    </div>
    <div className={`whitespace-pre-wrap break-words p-4 text-sm ${body.trim() ? "" : "text-muted"}`}>{body.trim() || "Your review shows here"}</div>
  </article>;
}

/** Who a single-record form is about: a tile with initials, a name and up to three plain lines. */
export function PopupSubjectCard({ title, lines = [], initials }: { title: string; lines?: ReadonlyArray<string | null | undefined>; initials?: string }) {
  const tile = initials ?? title.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
  const shown = lines.filter((line): line is string => Boolean(line && line.trim())).slice(0, 3);
  return <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-3.5" data-attr="popup-subject-card">
    <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-[13px] font-extrabold text-primary" aria-hidden>{tile || "·"}</span>
    <div className="min-w-0">
      <p className="break-words text-[14.5px] font-bold leading-tight text-foreground">{title}</p>
      {shown.map((line, index) => <p key={index} className="mt-1 break-words text-[12.5px] text-muted">{line}</p>)}
    </div>
  </div>;
}
