"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Mail, MessageSquare, Phone } from "lucide-react";

import type { DemoManagerPaymentLedgerRow, ManagerPaymentBucket } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { parseMoneyAmount } from "@/lib/parse-money";
import { cn } from "@/lib/utils";

/**
 * The resident record's landing page — the property page's Preview, for a
 * person. Who they are, where they live, what is due, what is waiting on the
 * manager, and the last few things that happened. Every figure comes from
 * rows the sibling tabs already own; nothing here is computed a second way.
 */

export type ResidentOverviewResident = {
  name: string;
  email: string;
  phone?: string;
  propertyLabel: string;
  roomLabel: string;
  signedMonthlyRent: number | null;
  leaseStart: string;
  leaseEnd: string;
  stage: "potential" | "current" | "past";
  statusLabel: string;
  axisId: string;
  moveInInstructions?: string;
};

export type ResidentOverviewServiceItem = {
  id: string;
  title: string;
  detail: string;
  bucket: "pending" | "scheduled" | "completed";
  href: string;
};

export type ResidentOverviewLinks = {
  payments?: string;
  lease?: string;
  application?: string;
  services?: string;
  communication?: string;
  tours?: string;
};

const STAGE_LABEL: Record<ResidentOverviewResident["stage"], string> = {
  potential: "Applicant",
  current: "Current",
  past: "Past",
};

const LEASE_BUCKET_LABEL: Record<LeasePipelineRow["bucket"], string> = {
  manager: "Waiting on you",
  resident: "Waiting on resident",
  signed: "Signed",
};

const PAYMENT_TONE: Record<ManagerPaymentBucket, string> = {
  overdue: "text-[var(--status-overdue-fg)]",
  pending: "text-foreground",
  paid: "text-muted",
};

const SERVICE_TONE: Record<ResidentOverviewServiceItem["bucket"], string> = {
  pending: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  scheduled: "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  completed: "bg-[var(--secondary)] text-muted",
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function formatUsd(amount: number): string {
  return usd.format(amount);
}

function ledgerBalance(rows: DemoManagerPaymentLedgerRow[], bucket: ManagerPaymentBucket): number {
  return rows.filter((row) => row.bucket === bucket).reduce((sum, row) => sum + parseMoneyAmount(row.balanceDue), 0);
}

function StatTile({
  label,
  value,
  detail,
  href,
  tone,
  dataAttr,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string;
  tone?: "danger" | "default";
  dataAttr: string;
}) {
  const body = (
    <>
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <span
        className={cn(
          "block truncate text-[1.3rem] font-semibold leading-none tracking-[-0.02em] sm:text-[1.45rem]",
          tone === "danger" ? "text-[var(--status-overdue-fg)]" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="truncate text-[12px] font-medium text-muted">{detail ?? ""}</span>
    </>
  );
  const className =
    "flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  if (href) {
    return (
      <Link href={href} className={cn(className, "hover:border-primary/35")} data-attr={dataAttr}>
        {body}
      </Link>
    );
  }
  return (
    <div className={className} data-attr={dataAttr}>
      {body}
    </div>
  );
}

function Card({
  title,
  action,
  children,
  dataAttr,
}: {
  title: string;
  action?: { label: string; href: string };
  children: ReactNode;
  dataAttr: string;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {action ? (
          <Link
            href={action.href}
            className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline"
          >
            {action.label}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <span className="w-28 shrink-0 text-[13px] text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-right text-[13.5px] font-medium text-foreground sm:text-left">{value}</span>
    </div>
  );
}

export function ResidentOverviewPanel({
  resident,
  ledgerRows,
  leaseRows,
  services,
  links,
}: {
  resident: ResidentOverviewResident;
  ledgerRows: DemoManagerPaymentLedgerRow[];
  leaseRows: LeasePipelineRow[];
  services: ResidentOverviewServiceItem[];
  links: ResidentOverviewLinks;
}) {
  const overdue = ledgerBalance(ledgerRows, "overdue");
  const pending = ledgerBalance(ledgerRows, "pending");
  const balance = overdue + pending;
  const overdueCount = ledgerRows.filter((row) => row.bucket === "overdue").length;
  const pendingCount = ledgerRows.filter((row) => row.bucket === "pending").length;

  const lease = leaseRows[0] ?? null;
  // Before a lease exists, the dates on the record are what the applicant
  // asked for — say so rather than implying a signed term.
  const leaseValue = lease
    ? LEASE_BUCKET_LABEL[lease.bucket]
    : resident.leaseStart || resident.leaseEnd
      ? resident.stage === "potential"
        ? "Requested"
        : "On file"
      : "None yet";
  const leaseDetail = resident.leaseEnd
    ? `Ends ${resident.leaseEnd}`
    : resident.leaseStart
      ? `From ${resident.leaseStart}`
      : lease
        ? lease.stageLabel
        : undefined;

  const waitingServices = services.filter((item) => item.bucket === "pending");

  const needsYou: Array<{ id: string; title: string; detail: string; href?: string }> = [];
  if (overdueCount > 0) {
    needsYou.push({
      id: "overdue",
      title: `${overdueCount} charge${overdueCount === 1 ? "" : "s"} overdue`,
      detail: `${formatUsd(overdue)} past due`,
      href: links.payments,
    });
  }
  if (lease && lease.bucket === "manager") {
    needsYou.push({ id: "lease", title: "Lease waiting on you", detail: lease.stageLabel, href: links.lease });
  }
  if (resident.stage === "potential" && /pending|review|submitted/i.test(resident.statusLabel)) {
    needsYou.push({
      id: "application",
      title: "Application to review",
      detail: resident.statusLabel,
      href: links.application,
    });
  }
  for (const item of waitingServices.slice(0, 3)) {
    needsYou.push({ id: `service-${item.id}`, title: item.title, detail: item.detail, href: item.href });
  }

  const recentLedger = [...ledgerRows]
    .sort((a, b) => (b.dueDateSortMs ?? 0) - (a.dueDateSortMs ?? 0))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-4 pb-6" data-slot="resident-overview" data-attr="resident-overview">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Balance"
          value={formatUsd(balance)}
          detail={
            overdueCount > 0
              ? `${formatUsd(overdue)} overdue`
              : pendingCount > 0
                ? `${pendingCount} upcoming`
                : "Nothing due"
          }
          href={links.payments}
          tone={overdueCount > 0 ? "danger" : "default"}
          dataAttr="resident-overview-balance"
        />
        <StatTile
          label="Rent"
          value={resident.signedMonthlyRent != null ? `${formatUsd(resident.signedMonthlyRent)}` : "—"}
          detail={resident.signedMonthlyRent != null ? "per month" : "Not set"}
          dataAttr="resident-overview-rent"
        />
        <StatTile
          label="Lease"
          value={leaseValue}
          detail={leaseDetail}
          href={links.lease}
          dataAttr="resident-overview-lease"
        />
        <StatTile
          label="Status"
          value={STAGE_LABEL[resident.stage]}
          detail={resident.statusLabel}
          href={resident.stage === "potential" ? links.application : undefined}
          dataAttr="resident-overview-status"
        />
      </div>

      <Card title="Needs you" dataAttr="resident-overview-needs-you">
        {needsYou.length === 0 ? (
          <p className="px-4 py-5 text-center text-[13px] text-muted">Nothing is waiting on you for this resident.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {needsYou.map((row) => {
              const inner = (
                <>
                  <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-foreground">{row.title}</span>
                    <span className="block truncate text-[12px] text-muted">{row.detail}</span>
                  </span>
                  {row.href ? <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden /> : null}
                </>
              );
              const className = "flex items-center gap-3 px-4 py-2.5";
              return (
                <li key={row.id} data-attr={`resident-overview-needs-${row.id}`}>
                  {row.href ? (
                    <Link href={row.href} className={cn(className, "transition hover:bg-accent/40")}>
                      {inner}
                    </Link>
                  ) : (
                    <div className={className}>{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Home" action={links.lease ? { label: "Lease", href: links.lease } : undefined} dataAttr="resident-overview-home">
          <div className="divide-y divide-border/70">
            <Field label="Property" value={resident.propertyLabel || "—"} />
            <Field label="Room" value={resident.roomLabel || "—"} />
            <Field
              label="Rent"
              value={resident.signedMonthlyRent != null ? `${formatUsd(resident.signedMonthlyRent)} / month` : "—"}
            />
            <Field label="Move in" value={resident.leaseStart || "—"} />
            <Field label="Move out" value={resident.leaseEnd || "—"} />
            {resident.moveInInstructions ? (
              <Field label="Move-in notes" value={<span className="whitespace-pre-line">{resident.moveInInstructions}</span>} />
            ) : null}
          </div>
        </Card>

        <Card
          title="Contact"
          action={links.communication ? { label: "Message", href: links.communication } : undefined}
          dataAttr="resident-overview-contact"
        >
          <div className="divide-y divide-border/70">
            <Field
              label="Email"
              value={
                resident.email ? (
                  <a href={`mailto:${resident.email}`} className="inline-flex items-center gap-1.5 break-all hover:underline">
                    <Mail className="size-3.5 shrink-0 text-muted" aria-hidden />
                    {resident.email}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Phone"
              value={
                resident.phone ? (
                  <a href={`tel:${resident.phone}`} className="inline-flex items-center gap-1.5 hover:underline">
                    <Phone className="size-3.5 shrink-0 text-muted" aria-hidden />
                    {resident.phone}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Field label="PropLane ID" value={<span className="font-mono text-[12.5px]">{resident.axisId || "—"}</span>} />
            {links.communication ? (
              <div className="px-4 py-3">
                <Link
                  href={links.communication}
                  className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground transition hover:border-primary/40 hover:text-primary"
                  data-attr="resident-overview-message"
                >
                  <MessageSquare className="size-4" aria-hidden />
                  Open conversation
                </Link>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <div className={cn("grid gap-4", links.services ? "lg:grid-cols-2" : "")}>
        <Card
          title="Payments"
          action={links.payments ? { label: "All payments", href: links.payments } : undefined}
          dataAttr="resident-overview-payments"
        >
          {recentLedger.length === 0 ? (
            <p className="px-4 py-5 text-center text-[13px] text-muted">No charges yet.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {recentLedger.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-foreground">{row.chargeTitle}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {row.dueDate} · {row.statusLabel}
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-[13.5px] font-semibold tabular-nums", PAYMENT_TONE[row.bucket])}>
                    {row.bucket === "paid" ? row.lineAmount : row.balanceDue}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {links.services ? (
        <Card
          title="Services"
          action={{ label: "All services", href: links.services }}
          dataAttr="resident-overview-services"
        >
          {services.length === 0 ? (
            <p className="px-4 py-5 text-center text-[13px] text-muted">No service requests yet.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {services.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-accent/40">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
                      <span className="block truncate text-[12px] text-muted">{item.detail}</span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-px text-[11px] font-semibold capitalize",
                        SERVICE_TONE[item.bucket],
                      )}
                    >
                      {item.bucket}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        ) : null}
      </div>
    </div>
  );
}
