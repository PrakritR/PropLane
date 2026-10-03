import type { ReactNode } from "react";

/** Previews receive the same controlled draft or server amounts as the committing action. */
export function PopupRecordPreview({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm" data-attr="popup-record-preview">
    {rows.map(row => <div key={row.label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3"><dt className="text-muted">{row.label}</dt><dd className="min-w-0 break-words font-semibold">{row.value || "Not set"}</dd></div>)}
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
