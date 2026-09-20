"use client";

import Link from "next/link";

/**
 * A record-shell tab that is a link to a related person or payment, not a
 * second copy of that surface. Empty copy is a heading, never grey subtext.
 */
export function PortalRecordRelatedPanel({
  title,
  value,
  href,
  empty,
}: {
  title: string;
  value?: string;
  href?: string;
  empty: string;
}) {
  if (!value && !href) {
    return (
      <div className="px-1 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-foreground">{empty}</p>
      </div>
    );
  }
  const body = (
    <>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {value ? <p className="mt-1 text-sm text-foreground">{value}</p> : null}
    </>
  );
  if (!href) {
    return <div className="px-1 py-4">{body}</div>;
  }
  return (
    <Link
      href={href}
      className="mt-3 block rounded-xl border border-border bg-card px-4 py-3"
      data-attr="record-related-open"
    >
      {body}
    </Link>
  );
}
