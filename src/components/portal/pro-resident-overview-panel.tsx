"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  ClipboardList,
  FileText,
  Footprints,
  Home,
  Shield,
  Wrench,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  buildResidentLifecycle,
  formatResidentMoney,
  formatResidentShortDate,
  residentHeaderStageLine,
  type ResidentLifecycleAction,
  type ResidentLifecycleSnapshot,
  type ResidentNeedsAttentionItem,
} from "@/lib/manager-resident-lifecycle";
import { parseMoneyAmount } from "@/lib/parse-money";
import { formatPortalListDate } from "@/lib/portal-display-dates";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";

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
  backgroundCheck?: string;
  inspections?: string;
};

const NEEDS_ICONS: Record<string, LucideIcon> = {
  tour: Footprints,
  application: ClipboardList,
  shield: Shield,
  lease: FileText,
  inspection: Home,
  payments: AlertCircle,
  services: Wrench,
  "user-plus": UserPlus,
};

type NeedsRowItem = ResidentNeedsAttentionItem & { onSelect?: () => void };

function NeedsRow({
  item,
  onInlineAction,
  onNavigate,
}: {
  item: NeedsRowItem;
  onInlineAction?: (actionId: string) => void;
  onNavigate?: (href: string) => void;
}) {
  const Icon = NEEDS_ICONS[item.icon] ?? AlertCircle;
  const target = item.href;
  return (
    <div
      className={cn(
        "group relative border-t border-border/70 first:border-t-0",
        item.urgent && "bg-[var(--status-overdue-bg)]/30",
      )}
      data-rt-row
      data-rt-todo
    >
      <button
        type="button"
        className="flex w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => (item.onSelect ? item.onSelect() : target && onNavigate?.(target))}
        data-attr="resident-needs-attention-row"
      >
        <span
          className={cn(
            "flex size-[34px] shrink-0 items-center justify-center rounded-full bg-secondary text-muted",
            item.urgent && "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
          )}
        >
          <Icon className="size-[17px]" strokeWidth={1.8} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline justify-between gap-4">
          <span className="truncate text-[14.5px] font-semibold text-foreground">{item.title}</span>
          <span
            className={cn(
              "max-w-[62%] truncate text-right text-[13px] text-muted transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
              item.inline && "group-hover:opacity-0",
            )}
          >
            {item.fact}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted/70" aria-hidden />
      </button>
      {item.inline ? (
        <button
          type="button"
          className="absolute right-11 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1.5 text-[13.5px] font-semibold text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-rt-inline
          onClick={(e) => {
            e.stopPropagation();
            onInlineAction?.(item.inline!.actionId);
          }}
        >
          {item.inline.label}
        </button>
      ) : null}
    </div>
  );
}

function PreviewCard({
  title,
  viewAllHref,
  children,
  dataAttr,
}: {
  title: string;
  viewAllHref?: string;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm" data-rt-prev={dataAttr}>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {viewAllHref ? (
          <Link href={viewAllHref} className="text-[13px] font-semibold text-primary hover:underline" data-attr="resident-preview-view-all">
            View all
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function runNextAction(
  next: ResidentLifecycleAction,
  onAction: (id: string) => void,
  onNavigate: (href: string) => void,
) {
  if (next.kind === "navigate") onNavigate(next.href);
  else onAction(next.actionId);
}

export function ResidentOverviewPanel({
  resident,
  ledgerRows,
  leaseRows,
  services,
  links,
  lifecycleInput,
  onNavigate,
  onInlineAction,
  onNextAction,
  preferredContactLabel,
  onCopyField,
  extraNeedsYou,
}: {
  resident: ResidentOverviewResident;
  ledgerRows: DemoManagerPaymentLedgerRow[];
  leaseRows: LeasePipelineRow[];
  services: ResidentOverviewServiceItem[];
  links: ResidentOverviewLinks;
  lifecycleInput?: Parameters<typeof buildResidentLifecycle>[0];
  onNavigate?: (href: string) => void;
  onInlineAction?: (actionId: string) => void;
  onNextAction?: (actionId: string) => void;
  preferredContactLabel?: string;
  onCopyField?: (label: string, value: string) => void;
  /** Extra "Needs attention" lines owned by the caller (late move-in forms); shown first. */
  extraNeedsYou?: Array<{ id: string; title: string; detail: string; href?: string; onClick?: () => void }>;
}) {
  const [showAllNeeds, setShowAllNeeds] = useState(false);

  const lifecycle: ResidentLifecycleSnapshot = useMemo(() => {
    const base = lifecycleInput ?? {
      directoryStage: resident.stage,
      application: null,
      leaseRows,
      ledgerRows,
      hasPortalAccount: true,
      roomLabel: resident.roomLabel,
      propertyLabel: resident.propertyLabel,
      moveInDate: resident.leaseStart,
      moveOutDate: resident.leaseEnd,
      signedMonthlyRent: resident.signedMonthlyRent,
    };
    return buildResidentLifecycle(base, {
      application: links.application ?? "#",
      backgroundCheck: links.backgroundCheck ?? links.application ?? "#",
      lease: links.lease ?? "#",
      payments: links.payments ?? "#",
      tours: links.tours ?? "#",
      inspections: links.inspections ?? "#",
      services: links.services ?? "#",
    });
  }, [lifecycleInput, resident, leaseRows, ledgerRows, links]);

  const allNeeds: NeedsRowItem[] = useMemo(
    () => [
      ...(extraNeedsYou ?? []).map((extra, index): NeedsRowItem => ({
        id: extra.id,
        icon: "lease",
        title: extra.title,
        fact: extra.detail,
        urgent: true,
        rank: -1000 + index,
        href: extra.href,
        onSelect: extra.onClick,
      })),
      ...lifecycle.todo,
    ],
    [extraNeedsYou, lifecycle.todo],
  );
  const shownNeeds = showAllNeeds ? allNeeds : allNeeds.slice(0, 5);
  const navigate = onNavigate ?? ((href: string) => {
    if (href.startsWith("/") || href.startsWith("http")) window.location.assign(href);
  });

  const detailRows = [
    { key: "Property", value: resident.propertyLabel },
    { key: "Room", value: resident.roomLabel },
    resident.signedMonthlyRent != null
      ? { key: "Rent", value: `${formatResidentMoney(Math.round(resident.signedMonthlyRent * 100))} / month` }
      : null,
    resident.leaseStart ? { key: "Move in", value: formatResidentShortDate(resident.leaseStart) || resident.leaseStart } : null,
    resident.leaseEnd ? { key: "Move out", value: formatResidentShortDate(resident.leaseEnd) || resident.leaseEnd } : null,
    resident.email ? { key: "Email", value: resident.email, copy: true, gap: true } : null,
    resident.phone ? { key: "Phone", value: resident.phone, copy: true } : null,
    preferredContactLabel ? { key: "Prefers", value: preferredContactLabel } : null,
  ].filter(Boolean) as Array<{ key: string; value: string; copy?: boolean; gap?: boolean }>;

  const lease = leaseRows[0];
  const stage = lifecycle.stage;
  const previews: React.ReactNode[] = [];

  if (links.tours && ["prospect", "applicant", "approved"].includes(stage)) {
    previews.push(
      <PreviewCard key="tours" title="Tours" viewAllHref={links.tours} dataAttr="tours">
        <p className="px-5 py-4 text-sm text-muted">Open Tours for this resident&apos;s schedule.</p>
      </PreviewCard>,
    );
  }
  if (lease && links.lease && ["approved", "lease_sent", "signed"].includes(stage)) {
    previews.push(
      <PreviewCard key="lease" title="Lease" viewAllHref={links.lease} dataAttr="lease">
        <NeedsRow
          item={{
            id: "lease-prev",
            icon: "lease",
            title: "Lease",
            fact: lease.stageLabel,
            urgent: false,
            rank: 0,
            href: links.lease,
          }}
          onNavigate={navigate}
        />
      </PreviewCard>,
    );
  }
  if (links.payments && ledgerRows.length > 0 && !["prospect", "applicant"].includes(stage)) {
    const ordered = [...ledgerRows]
      .sort((a, b) => {
        const rank = (r: DemoManagerPaymentLedgerRow) => (r.bucket === "overdue" ? 0 : r.bucket === "pending" ? 1 : 2);
        return rank(a) - rank(b) || (a.dueDateSortMs ?? 0) - (b.dueDateSortMs ?? 0);
      })
      .slice(0, 3);
    previews.push(
      <PreviewCard key="payments" title="Payments" viewAllHref={links.payments} dataAttr="payments">
        {ordered.map((row) => (
          <NeedsRow
            key={row.id}
            item={{
              id: row.id,
              icon: "payments",
              title: row.chargeTitle,
              fact: (() => {
                const due =
                  /^\d{4}-\d{2}-\d{2}$/.test((row.dueDate ?? "").trim())
                    ? formatPortalListDate(row.dueDate)
                    : row.dueDate;
                return row.bucket === "paid"
                  ? `Paid ${due}`
                  : row.bucket === "overdue"
                    ? `Overdue · ${due}`
                    : `Due ${due}`;
              })(),
              urgent: row.bucket === "overdue",
              rank: 0,
              href: links.payments,
            }}
            onNavigate={navigate}
          />
        ))}
      </PreviewCard>,
    );
  }
  if (links.services && services.length > 0 && ["current", "moving_out"].includes(stage)) {
    previews.push(
      <PreviewCard key="services" title="Services" viewAllHref={links.services} dataAttr="services">
        {services.slice(0, 3).map((s) => (
          <NeedsRow
            key={s.id}
            item={{
              id: s.id,
              icon: "services",
              title: s.title,
              fact: s.detail,
              urgent: false,
              rank: 0,
              href: s.href,
            }}
            onNavigate={navigate}
          />
        ))}
      </PreviewCard>,
    );
  }

  const curIdx = lifecycle.steps.findIndex((s) => s.state === "current");
  const phoneKeep = new Set(
    [curIdx, curIdx + 1 < lifecycle.steps.length ? curIdx + 1 : curIdx - 1].filter((i) => i >= 0),
  );

  return (
    <div className="flex flex-col gap-6 pb-6" data-rt-overview data-rt-stage-id={lifecycle.stage}>
      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card px-7 pb-5 pt-6 shadow-sm" data-rt-card>
        {lifecycle.headerFact ? (
          <p className="mb-4 hidden text-center text-[13px] text-muted sm:block" data-rt-pfact>
            {residentHeaderStageLine(lifecycle)}
          </p>
        ) : null}
        {/* Every step is the same shape (dot · label · date line, top-aligned), so a step
            with no date never sits lower than its neighbours. */}
        <ol className="flex list-none items-start gap-0 p-0" data-rt-track aria-label="Stage progress">
          {lifecycle.steps.map((step, index) => (
            <li
              key={step.id}
              data-rt-stage={step.id}
              data-rt-keep={phoneKeep.has(index) ? "" : undefined}
              data-rt-first={index === Math.min(...phoneKeep) ? "" : undefined}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center justify-start gap-2 self-start text-center",
                "max-sm:data-[rt-keep]:flex max-sm:data-[rt-keep=false]:hidden",
                index > 0 &&
                  "before:absolute before:right-1/2 before:top-[6px] before:-z-0 before:h-0.5 before:w-full before:rounded-full before:bg-foreground/10",
                (step.state === "done" || step.state === "current") && "before:bg-primary",
              )}
            >
              <span
                className={cn(
                  "relative z-[1] box-border size-3.5 rounded-full border-2 border-foreground/15 bg-card",
                  step.state === "done" && "border-primary bg-primary",
                  step.state === "current" && "border-primary bg-primary shadow-[0_0_0_2px_var(--background),0_0_0_6px_color-mix(in_srgb,var(--primary)_18%,transparent)]",
                )}
              />
              <span
                className={cn(
                  "px-1 text-[13px] font-medium leading-tight text-muted",
                  step.state === "current" && "font-bold text-primary",
                  step.state === "done" && "text-muted",
                )}
                data-rt-stage-label={step.state === "current" ? "" : undefined}
              >
                {step.label}
              </span>
              <span className="-mt-1 min-h-4 text-xs leading-4 text-muted/80" aria-hidden={step.date ? undefined : true}>
                {step.date ?? ""}
              </span>
            </li>
          ))}
        </ol>
        {lifecycle.next ? (
          <div
            className="mt-5 flex flex-col gap-2.5 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between"
            data-rt-next
          >
            <span className="text-[13px] text-muted">Next step</span>
            <Button
              onClick={() => {
                if (lifecycle.next!.kind === "callback") onNextAction?.(lifecycle.next!.actionId);
                else runNextAction(lifecycle.next!, onNextAction ?? (() => {}), navigate);
              }}
              data-attr="resident-overview-next-step"
            >
              {lifecycle.next.label}
            </Button>
          </div>
        ) : null}
      </div>

      {lifecycle.kpiTiles.length > 0 ? (
        <div
          className="grid auto-cols-fr grid-flow-col overflow-x-auto rounded-2xl border border-border/80 bg-card shadow-sm max-sm:flex max-sm:scrollbar-none"
          data-rt-kpis
        >
          {lifecycle.kpiTiles.map((tile, i) => (
            <div
              key={tile.label}
              className={cn(
                "flex min-w-0 flex-col gap-1 px-6 py-4 max-sm:min-w-32 max-sm:shrink-0",
                i > 0 && "border-l border-border/70",
              )}
            >
              <span className="text-[12.5px] text-muted">{tile.label}</span>
              <span className="truncate text-lg font-bold tracking-tight">{tile.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_344px] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm lg:row-start-1" data-rt-needs>
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
            <span className="text-sm font-semibold">Needs attention</span>
          </div>
          {shownNeeds.length > 0 ? (
            <>
              {shownNeeds.map((item) => (
                <NeedsRow key={item.id} item={item} onInlineAction={onInlineAction} onNavigate={navigate} />
              ))}
              {allNeeds.length > 5 ? (
                <div className="flex justify-center border-t border-border/70 py-2.5">
                  <button
                    type="button"
                    className="text-[13px] font-semibold text-primary hover:underline"
                    data-rt-showall
                    onClick={() => setShowAllNeeds((v) => !v)}
                  >
                    {showAllNeeds ? "Show fewer" : `Show all ${allNeeds.length}`}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-2.5 px-5 py-4 text-sm text-muted" data-rt-clear>
              <Check className="size-[17px] text-[var(--status-confirmed-fg)]" aria-hidden />
              <span>Nothing needs your attention</span>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm lg:col-start-2 lg:row-span-2" data-rt-details>
          <div className="border-b border-border/70 px-5 py-3.5">
            <span className="text-sm font-semibold">Details</span>
          </div>
          <div className="py-1.5 pb-3">
            {detailRows.map((row) => (
              <div
                key={row.key}
                className={cn(
                  "relative flex min-h-[38px] items-center gap-3 px-5 py-2",
                  row.gap && "mt-2 border-t border-border/70 pt-4",
                )}
              >
                <span className="w-[76px] shrink-0 text-[13px] text-muted">{row.key}</span>
                <span className="min-w-0 flex-1 truncate text-sm" title={row.value}>{row.value}</span>
                {row.copy ? (
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                    aria-label={`Copy ${row.key.toLowerCase()}`}
                    onClick={() => onCopyField?.(row.key, row.value)}
                  >
                    <span className="text-xs font-semibold">⎘</span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {previews.length > 0 ? (
          <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-2 rt-prevs">{previews}</div>
        ) : null}
      </div>
    </div>
  );
}
