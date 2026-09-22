"use client";

import Link from "next/link";
import { Mail, MessageSquare, Phone } from "lucide-react";

import type { DemoManagerPaymentLedgerRow, ManagerPaymentBucket } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  RecordFactCard,
  RecordFactRow,
  RecordNeedsYou,
  RecordRowsCard,
  RecordStatTiles,
  StatTile,
} from "@/components/portal/portal-record-overview-kit";
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

export function ResidentOverviewPanel({
  resident,
  ledgerRows,
  leaseRows,
  services,
  links,
  extraNeedsYou = [],
}: {
  resident: ResidentOverviewResident;
  ledgerRows: DemoManagerPaymentLedgerRow[];
  leaseRows: LeasePipelineRow[];
  services: ResidentOverviewServiceItem[];
  links: ResidentOverviewLinks;
  extraNeedsYou?: Array<{ id: string; title: string; detail: string; href?: string; onClick?: () => void }>;
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

  const needsYou: Array<{ id: string; title: string; detail: string; href?: string; onClick?: () => void }> = [...extraNeedsYou];
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
      <RecordStatTiles>
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
      </RecordStatTiles>

      <RecordNeedsYou items={needsYou} dataAttr="resident-overview-needs-you" itemDataAttrPrefix="resident-overview-needs" />

      <div className="grid gap-4 lg:grid-cols-2">
        <RecordFactCard title="Home" action={links.lease ? { label: "Lease", href: links.lease } : undefined} dataAttr="resident-overview-home">
          <div className="divide-y divide-border/70">
            <RecordFactRow label="Property" value={resident.propertyLabel || "—"} />
            <RecordFactRow label="Room" value={resident.roomLabel || "—"} />
            <RecordFactRow
              label="Rent"
              value={resident.signedMonthlyRent != null ? `${formatUsd(resident.signedMonthlyRent)} / month` : "—"}
            />
            <RecordFactRow label="Move in" value={resident.leaseStart || "—"} />
            <RecordFactRow label="Move out" value={resident.leaseEnd || "—"} />
            {resident.moveInInstructions ? (
              <RecordFactRow label="Move-in notes" value={<span className="whitespace-pre-line">{resident.moveInInstructions}</span>} />
            ) : null}
          </div>
        </RecordFactCard>

        <RecordFactCard
          title="Contact"
          action={links.communication ? { label: "Message", href: links.communication } : undefined}
          dataAttr="resident-overview-contact"
        >
          <div className="divide-y divide-border/70">
            <RecordFactRow
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
            <RecordFactRow
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
            <RecordFactRow label="PropLane ID" value={<span className="font-mono text-[12.5px]">{resident.axisId || "—"}</span>} />
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
        </RecordFactCard>
      </div>

      <div className={cn("grid gap-4", links.services ? "lg:grid-cols-2" : "")}>
        <RecordRowsCard
          title="Payments"
          action={links.payments ? { label: "All payments", href: links.payments } : undefined}
          dataAttr="resident-overview-payments"
          emptyLabel="No charges yet."
          rows={recentLedger.map((row) => ({
            id: row.id,
            title: row.chargeTitle,
            sub: `${row.dueDate} · ${row.statusLabel}`,
            figure: (
              <span className={cn("text-[13.5px] font-semibold tabular-nums", PAYMENT_TONE[row.bucket])}>
                {row.bucket === "paid" ? row.lineAmount : row.balanceDue}
              </span>
            ),
          }))}
        />

        {links.services ? (
          <RecordRowsCard
            title="Services"
            action={{ label: "All services", href: links.services }}
            dataAttr="resident-overview-services"
            emptyLabel="No service requests yet."
            rows={services.slice(0, 5).map((item) => ({
              id: item.id,
              title: item.title,
              sub: item.detail,
              href: item.href,
              figure: (
                <span className={cn("rounded-full px-2 py-px text-[11px] font-semibold capitalize", SERVICE_TONE[item.bucket])}>
                  {item.bucket}
                </span>
              ),
            }))}
          />
        ) : null}
      </div>
    </div>
  );
}
