"use client";

/**
 * The contact-details column at the right edge of Communication (1280px and up).
 *
 * It only restates what the open conversation already carries: who it is with,
 * their phone and email, the records the thread is about, and the sends already
 * scheduled for them. Nothing is fetched here and nothing is invented: a row with
 * no value is not drawn, and a section with no rows is not drawn.
 */
import Link from "next/link";
import { useThreadScheduledItems } from "@/components/portal/use-thread-scheduled-cards";
import { InboxAvatar, inboxInitials } from "@/components/portal/portal-inbox-ui";
import { cn } from "@/lib/utils";

export type CommunicationDetailsRecord = {
  key: string;
  label: string;
  /** Kind and place, e.g. "Prospect · 14 Cedar Lane". */
  detail?: string;
  /** Null when this viewer's role has no page for the record. */
  href: string | null;
};

export type CommunicationDetails = {
  name: string;
  /** "Prospect", "Resident", "Vendor"… — omitted when the conversation does not say. */
  role?: string;
  phone?: string | null;
  email?: string | null;
  records: CommunicationDetailsRecord[];
};

/**
 * Details for a resident's or vendor's selected conversation row: the name, the address and the
 * record the thread is about, exactly as the list row already carries them.
 */
export function communicationDetailsFromRow(
  row: {
    name: string;
    personEmail?: string;
    address?: string;
    recordRef?: { kind: string; id: string; label: string };
  } | null,
  recordHref: (kind: string, id: string) => string | null,
): CommunicationDetails | null {
  const name = row?.name?.trim();
  if (!row || !name) return null;
  const records: CommunicationDetailsRecord[] = [];
  if (row.recordRef) {
    records.push({
      key: `ref-${row.recordRef.kind}-${row.recordRef.id}`,
      label: row.recordRef.label,
      detail: row.address || undefined,
      href: recordHref(row.recordRef.kind, row.recordRef.id),
    });
  }
  return { name, email: row.personEmail?.trim() || null, records };
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-8 grid-cols-[88px_minmax(0,1fr)] items-center gap-2 text-[13.5px]">
      <span className="text-muted">{label}</span>
      <span className="truncate text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function RecordRow({ record }: { record: CommunicationDetailsRecord }) {
  const body = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-[10px] font-bold text-muted">
        {inboxInitials(record.label)}
      </span>
      <span className="min-w-0 text-[13.5px] leading-tight text-foreground">
        <span className="block truncate">{record.label}</span>
        {record.detail ? <span className="block truncate text-[12.5px] text-muted">{record.detail}</span> : null}
      </span>
    </>
  );
  const className = "-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5";
  return record.href ? (
    <Link
      href={record.href}
      className={cn(className, "transition-colors hover:bg-foreground/[0.04]")}
      data-attr="communication-details-record"
    >
      {body}
    </Link>
  ) : (
    <div className={className} data-attr="communication-details-record">
      {body}
    </div>
  );
}

export function CommunicationDetailsPane({ details }: { details: CommunicationDetails }) {
  const scheduled = useThreadScheduledItems(details.email ?? "");
  const hasFacts = Boolean(details.phone || details.email);
  return (
    <div className="flex min-h-0 flex-col" data-attr="communication-details">
      <div className="px-[18px] pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <InboxAvatar tile name={details.name} className="size-10 rounded-[10px] text-sm" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-tight text-foreground">{details.name}</p>
            {details.role ? <p className="mt-px truncate text-[12.5px] leading-tight text-muted">{details.role}</p> : null}
          </div>
        </div>
        {hasFacts ? (
          <div className="mt-2.5">
            {details.phone ? <DetailRow label="Phone" value={details.phone} /> : null}
            {details.email ? <DetailRow label="Email" value={details.email} /> : null}
          </div>
        ) : null}
      </div>
      {details.records.length > 0 ? (
        <section className="border-t border-border px-[18px] py-3" data-attr="communication-details-records">
          <h4 className="mb-1.5 text-xs font-semibold text-muted">Linked records</h4>
          {details.records.map((record) => (
            <RecordRow key={record.key} record={record} />
          ))}
        </section>
      ) : null}
      {scheduled.length > 0 ? (
        <section className="border-t border-border px-[18px] py-3" data-attr="communication-details-scheduled">
          <h4 className="mb-1.5 text-xs font-semibold text-muted">Scheduled</h4>
          {scheduled.map((item) => (
            <p key={item.id} className="truncate py-0.5 text-[13px] text-foreground/80" title={`${item.subject} · ${item.sendLabel}`}>
              {item.subject ? `${item.subject} · ` : ""}
              {item.sendLabel}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}
