"use client";

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
  links: ResidentOverviewLinks;
  lifecycleInput?: Parameters<typeof buildResidentLifecycle>[0];
  onNavigate?: (href: string) => void;
  onInlineAction?: (actionId: string) => void;
  onNextAction?: (actionId: string) => void;
  preferredContactLabel?: string;
  onCopyField?: (label: string, value: string) => void;
  /** Extra "Needs attention" lines owned by the caller (late move-in forms); shown first. */
  extraNeedsYou?: Array<{ id: string; title: string; detail?: string; href?: string; onClick?: () => void }>;
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
        fact: extra.detail ?? "",
        urgent: true,
        rank: -1000 + index,
        href: extra.href,
        onSelect: extra.onClick,
      })),
      ...lifecycle.todo,
    ],
    [extraNeedsYou, lifecycle.todo],
  );
  const nextActionId = lifecycle.next?.kind === "callback" ? lifecycle.next.actionId : null;
  const nextHref = lifecycle.next?.kind === "navigate" ? lifecycle.next.href : null;
  // A Needs-attention line whose action is the Next step button shows no button of its own.
  const dedupedNeeds = allNeeds.map((item) =>
    item.inline && (item.inline.actionId === nextActionId || (nextHref && item.href === nextHref))
      ? { ...item, inline: undefined }
      : item,
  );
  const shownNeeds = showAllNeeds ? dedupedNeeds : dedupedNeeds.slice(0, 5);
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

  const curIdx = lifecycle.steps.findIndex((s) => s.state === "current");
  const phoneKeep = new Set(
    [curIdx, curIdx + 1 < lifecycle.steps.length ? curIdx + 1 : curIdx - 1].filter((i) => i >= 0),
  );

  return (
    <div className="flex flex-col gap-6 pb-6" data-rt-overview data-rt-stage-id={lifecycle.stage}>
      <div className="overflow-hidden rounded-2xl border border-border/80 bg-card px-7 pb-5 pt-6 shadow-sm max-sm:px-4" data-rt-card>
        {lifecycle.headerFact ? (
          <p className="mb-4 hidden text-center text-[13px] text-muted sm:block" data-rt-pfact>
            {residentHeaderStageLine(lifecycle)}
          </p>
        ) : null}
        {/* Every step is the same shape: a fixed-height dot row (the connector is drawn inside it,
            between dot centers), then the label, then a date line that is always reserved. Nothing
            step-specific (a connector, a ring, a missing date) changes a step's vertical position. */}
        <ol className="flex list-none items-start gap-0 p-0" data-rt-track aria-label="Stage progress">
          {lifecycle.steps.map((step, index) => {
            const reached = step.state === "done" || step.state === "current";
            return (
              <li
                key={step.id}
                data-rt-stage={step.id}
                data-rt-keep={phoneKeep.has(index) ? "" : undefined}
                data-rt-first={index === Math.min(...phoneKeep) ? "" : undefined}
                aria-current={step.state === "current" ? "step" : undefined}
                className={cn(
                  "relative flex min-w-0 flex-1 flex-col items-stretch text-center",
                  "max-sm:data-[rt-keep]:flex max-sm:data-[rt-keep=false]:hidden",
                )}
              >
                <div className="relative flex h-4 items-center justify-center" data-rt-dot-row>
                  {index > 0 ? (
                    <span
                      aria-hidden
                      data-rt-connector
                      className={cn(
                        "absolute right-1/2 top-1/2 h-0.5 w-full -translate-y-1/2 rounded-full",
                        reached ? "bg-primary" : "bg-foreground/10",
                      )}
                    />
                  ) : null}
                  <span
                    data-rt-dot
                    className={cn(
                      "relative z-[1] box-border size-3.5 shrink-0 rounded-full border-2 border-foreground/15 bg-card",
                      step.state === "done" && "border-primary bg-primary",
                      step.state === "current" && "border-primary bg-primary shadow-[0_0_0_2px_var(--background),0_0_0_6px_color-mix(in_srgb,var(--primary)_18%,transparent)]",
                    )}
                  />
                </div>
                <span
                  className={cn(
                    "mt-2 block px-1 text-[13px] font-medium leading-tight text-muted max-sm:px-0 max-sm:text-[11px]",
                    step.state === "current" && "font-bold text-primary",
                    step.state === "done" && "text-muted",
                  )}
                  data-rt-stage-label={step.state === "current" ? "" : undefined}
                >
                  {step.label}
                </span>
                <span className="mt-1 block h-4 text-xs leading-4 text-muted/80 max-sm:text-[11px]" aria-hidden={step.date ? undefined : true}>
                  {step.date ?? ""}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {lifecycle.next ? (
        <div
          className="flex flex-col gap-2.5 rounded-2xl border border-border/80 bg-card px-5 py-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between"
          data-rt-next
        >
          <div className="flex min-w-0 items-baseline gap-3.5" data-rt-next-copy>
            <span className="shrink-0 text-xs text-muted">Next step</span>
            {lifecycle.next.description ? (
              <span className="min-w-0 text-sm font-semibold text-foreground">{lifecycle.next.description}</span>
            ) : null}
          </div>
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

      {lifecycle.kpiTiles.length > 0 ? (
        <div className="grid gap-3 max-sm:grid-cols-2 sm:grid-cols-2 lg:grid-cols-4" data-rt-kpis>
          {lifecycle.kpiTiles.slice(0, 4).map((tile) => (
            <div
              key={tile.label}
              className="flex min-w-0 flex-col gap-1 rounded-2xl border border-border/80 bg-card px-4 py-3.5 shadow-sm"
            >
              <span className="text-[12.5px] text-muted">{tile.label}</span>
              <span className="truncate text-lg font-bold tracking-tight max-sm:overflow-visible max-sm:whitespace-normal max-sm:break-words max-sm:text-base">{tile.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm " data-rt-needs>
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

        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm " data-rt-details>
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

      </div>
    </div>
  );
}
