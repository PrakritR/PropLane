import Link from "next/link";

export function ManagerLinkGate({
  title,
  body,
  ps = false,
}: {
  title: string;
  body: string;
  /** Journey styling for the public `.ps` pages; the portal keeps the default card. */
  ps?: boolean;
}) {
  if (ps) {
    return (
      <div className="ps-j-gate" data-attr="manager-link-gate">
        <p className="ps-j-eyebrow">Manager link required</p>
        <h2 className="ps-h3">{title}</h2>
        <p>{body}</p>
        <div className="ps-j-btn-row">
          <Link href="/rent/browse" className="ps-btn ps-btn-line">
            Find a home
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="ps-gate-card mx-auto max-w-xl rounded-2xl border border-border bg-card px-6 py-8 text-center shadow-sm">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">Manager link required</p>
      <h2 className="mt-3 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}
