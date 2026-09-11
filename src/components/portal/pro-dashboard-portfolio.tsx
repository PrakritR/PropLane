"use client";

/**
 * Portfolio overview for the manager dashboard — the redesign's "Your portfolio,
 * in focus." head: four white metric cards, one suggested next step, and the
 * first few properties as cards. Everything here is derived from the same local
 * stores the list pages read; nothing is a new data source.
 */

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { cn } from "@/lib/utils";
import { propertyDetailHref, propertyListHref } from "@/lib/portal-detail-routes";
import {
  adminPropertyRentDisplayLabel,
  managerPropertyRowsForStage,
  type AdminPropertyRow,
} from "@/lib/demo-admin-property-inventory";

export type PortfolioStage = "listed" | "unlisted" | "drafts";

export type PortfolioPropertyCardData = {
  key: string;
  stage: PortfolioStage;
  title: string;
  address: string;
  spacesLabel: string;
  rentLabel: string;
  coverUrl: string | null;
};

const STAGE_LABEL: Record<PortfolioStage, string> = {
  listed: "Listed",
  unlisted: "Unlisted",
  drafts: "Draft",
};

const STAGE_PILL: Record<PortfolioStage, string> = {
  listed: "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  unlisted: "bg-[var(--secondary)] text-muted",
  drafts: "bg-accent text-primary",
};

function rowSpaces(row: AdminPropertyRow): number {
  const rooms = row.submission?.rooms?.length ?? 0;
  return rooms > 0 ? rooms : 1;
}

function rowCover(row: AdminPropertyRow): string | null {
  const url = row.submission?.housePhotoDataUrls?.[0]?.trim();
  return url ? url : null;
}

function rowTitle(row: AdminPropertyRow): string {
  return row.buildingName?.trim() || row.address?.trim() || "Untitled property";
}

/** Read every property the manager owns, grouped by stage, as card data plus totals. */
export function readPortfolioSnapshot(userId: string | null): {
  cards: PortfolioPropertyCardData[];
  propertyCount: number;
  rentableSpaces: number;
  draftCount: number;
} {
  const stages: Array<[PortfolioStage, Parameters<typeof managerPropertyRowsForStage>[0]]> = [
    ["listed", [2]],
    ["unlisted", [3]],
    ["drafts", [5]],
  ];
  const cards: PortfolioPropertyCardData[] = [];
  let rentableSpaces = 0;
  let draftCount = 0;
  for (const [stage, buckets] of stages) {
    for (const row of managerPropertyRowsForStage(buckets, userId)) {
      const key = row.listingId?.trim() || row.adminRefId.trim();
      if (!key) continue;
      if (stage === "drafts") draftCount += 1;
      else rentableSpaces += rowSpaces(row);
      const spaces = rowSpaces(row);
      cards.push({
        key,
        stage,
        title: rowTitle(row),
        address: row.address?.trim() || "",
        spacesLabel: stage === "drafts" ? "Setup in progress" : `${spaces} ${spaces === 1 ? "space" : "spaces"}`,
        rentLabel: adminPropertyRentDisplayLabel(row),
        coverUrl: rowCover(row),
      });
    }
  }
  return { cards, propertyCount: cards.length, rentableSpaces, draftCount };
}

export function PortfolioMetricCard({
  label,
  value,
  detail,
  href,
  dataAttr,
}: {
  label: string;
  value: string;
  detail: string;
  href: string;
  dataAttr?: string;
}) {
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="flex min-w-0 flex-col gap-1 rounded-2xl border border-border bg-card px-4 py-4 shadow-sm transition hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[1.75rem] font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground">{value}</span>
      <span className="text-xs text-muted">{detail}</span>
    </Link>
  );
}

export function PortfolioNextStep({
  title,
  detail,
  actionLabel,
  href,
  dataAttr,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  href: string;
  dataAttr?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-accent px-4 py-3.5 sm:gap-4 sm:px-5"
      data-attr={dataAttr}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm" aria-hidden>
        <Sparkles className="size-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <Link
        href={href}
        className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg bg-card px-3.5 text-sm font-semibold text-primary shadow-sm transition hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        {actionLabel}
        <ArrowUpRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

export function PortfolioPropertyCard({
  card,
  basePath,
}: {
  card: PortfolioPropertyCardData;
  basePath: string;
}) {
  const href = propertyDetailHref(basePath, card.stage, card.key, "preview");
  return (
    <Link
      href={href}
      data-attr="dashboard-property-card"
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <div className="relative aspect-[16/9] w-full bg-[var(--secondary)]">
        {card.coverUrl ? (
          // Manager-uploaded photo (data or storage URL) — never a stock stand-in.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <NoImagePlaceholder label="No property photo" />
        )}
        <span
          className={cn(
            "absolute left-3 top-3 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            STAGE_PILL[card.stage],
          )}
        >
          {STAGE_LABEL[card.stage]}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-4 py-3">
        <p className="truncate text-[15px] font-semibold text-foreground">{card.title}</p>
        <p className="truncate text-sm text-muted">{card.address || "Address to come"}</p>
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs text-muted">
          <span>{card.spacesLabel}</span>
          <span className="font-semibold text-foreground">{card.rentLabel}</span>
        </div>
      </div>
    </Link>
  );
}

export function PortfolioPropertiesSection({
  cards,
  basePath,
}: {
  cards: PortfolioPropertyCardData[];
  basePath: string;
}) {
  const shown = cards.slice(0, 3);
  return (
    <section className="space-y-3" data-attr="dashboard-your-properties">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Your properties</h2>
        <Link
          href={propertyListHref(basePath, "listed")}
          className="inline-flex min-h-10 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-primary transition hover:bg-accent/70"
          data-attr="dashboard-manage-properties"
        >
          Manage properties →
        </Link>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted">
          No properties yet. Add your first home to start leasing.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((card) => (
            <PortfolioPropertyCard key={card.key} card={card} basePath={basePath} />
          ))}
        </div>
      )}
    </section>
  );
}
