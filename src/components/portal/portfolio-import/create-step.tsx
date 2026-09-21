"use client";

/**
 * Step 3 — the one-shot create. Invites default OFF: the manager opts in
 * explicitly at this screen (`sendInvites`), never earlier. Creation is one
 * transaction per property; a failure rolls that property back and names the
 * row (`PortfolioImportCreateResult.failures`).
 */

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, CheckCircle2, Home, ListChecks, Mail, Receipt, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import type { PortfolioImportCreateResult, PortfolioImportProposal } from "@/lib/portfolio-import/types";

function Row({ icon: Icon, label, value }: { icon: typeof Home; label: string; value: string }) {
  return (
    <div className="flex min-h-[52px] flex-col gap-1 border-t border-border px-3.5 py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="flex min-w-0 shrink-0 items-center gap-2 text-[14px] font-semibold text-foreground">
        <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.6} aria-hidden />
        <span>{label}</span>
      </span>
      <span className="text-[13px] text-foreground/70 sm:text-right">{value}</span>
    </div>
  );
}

export function PortfolioImportCreateStep({
  proposal,
  result,
  creating,
  onBack,
  onCreate,
}: {
  proposal: PortfolioImportProposal;
  result: PortfolioImportCreateResult | null;
  creating: boolean;
  onBack: () => void;
  onCreate: (sendInvites: boolean) => Promise<void>;
}) {
  const [sendInvites, setSendInvites] = useState(false);

  const includedResidents = proposal.properties.reduce(
    (sum, p) => sum + p.residents.filter((r) => r.status !== "skip").length,
    0,
  );
  const roomCount = proposal.properties.reduce((sum, p) => sum + p.rooms.length, 0);
  const leaseCount = includedResidents;
  const chargeCount = proposal.properties.reduce((sum, p) => sum + p.charges.length, 0);
  const taskCount = proposal.properties.reduce((sum, p) => sum + p.tasks.length, 0);

  if (result) {
    const failed = result.failures.length > 0;
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-0">
        <h1 className="mb-4 flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">
          {failed ? (
            <AlertCircle className="size-5 shrink-0 text-amber-600" aria-hidden />
          ) : (
            <CheckCircle2 className="size-5 shrink-0 text-[var(--status-approved-fg)]" aria-hidden />
          )}
          {failed ? "Imported, with some rows left behind" : "Portfolio created"}
        </h1>

        <div className="rounded-2xl border border-border bg-card" data-attr="portfolio-import-created-summary">
          <Row icon={Home} label="Properties & rooms" value={`${result.created.properties} · ${result.created.rooms} rooms`} />
          <Row icon={Users} label="Residents & leases" value={`${result.created.residents} residents · ${result.created.leases} leases`} />
          <Row icon={Receipt} label="Charges" value={`${result.created.charges}`} />
          <Row icon={ListChecks} label="Tasks" value={`${result.created.tasks}`} />
          <Row icon={Mail} label="Invites" value={`${result.created.invites}`} />
        </div>

        {failed ? (
          <div className="mt-4 rounded-2xl border border-border bg-card" data-attr="portfolio-import-failures">
            <p className="border-b border-border px-3.5 py-2.5 text-[13px] text-foreground/70">
              One transaction per property; a failure rolls that property back and says which row.
            </p>
            {result.failures.map((failure, index) => (
              <div key={`${failure.propertyKey}-${index}`} className="border-t border-border px-3.5 py-2.5 first:border-t-0" data-attr="portfolio-import-failure-row">
                <p className="text-[14px] font-semibold text-foreground">{failure.address}</p>
                <p className="text-[13px] text-foreground/70">
                  {failure.row != null ? `Row ${failure.row} — ` : ""}
                  {failure.message}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end">
          <Link
            href="/portal/properties?tab=drafts"
            data-attr="portfolio-import-done"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--btn-primary)_92%,#000)] px-4 text-[14px] font-semibold text-white hover:brightness-110"
          >
            Done
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-0">
      <div className="mb-1 flex items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to review"
          data-attr="portfolio-import-back-to-review"
          className="-ml-1 flex min-h-8 items-center gap-0.5 rounded-lg px-1 text-sm font-medium text-primary hover:bg-accent/40"
        >
          <span aria-hidden>‹</span>
          <span>Review</span>
        </button>
      </div>
      <h1 className="mb-5 text-[20px] font-bold tracking-tight text-foreground md:text-[22px]" data-attr="portfolio-import-create-title">
        {`Create ${proposal.properties.length} ${proposal.properties.length === 1 ? "property" : "properties"}, ${includedResidents} residents, ${leaseCount} leases, ${chargeCount} charges, ${taskCount} tasks`}
      </h1>

      <div className="rounded-2xl border border-border bg-card">
        <Row icon={Home} label="Properties & rooms" value={`${proposal.properties.length} · ${roomCount} rooms, as drafts you publish later`} />
        <Row icon={Users} label="Residents & leases" value={`${includedResidents} current residents with uploaded-lease records`} />
        <Row icon={Receipt} label="Charges" value="September rent + deposits, as recorded" />
        <Row icon={ListChecks} label="Tasks" value={`${taskCount} · missing end dates, unsigned leases, move-in photos`} />
        <div className="flex min-h-[52px] items-center justify-between gap-3 border-t border-border px-3.5 py-2">
          <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-foreground">
            <Mail className="size-4 shrink-0 text-muted" strokeWidth={1.6} aria-hidden />
            Invites
          </span>
          <label className="flex shrink-0 items-center gap-2 text-[13px] text-foreground/80">
            <input
              type="checkbox"
              checked={sendInvites}
              onChange={(e) => setSendInvites(e.target.checked)}
              data-attr="portfolio-import-send-invites"
              className="size-4 rounded border-border accent-[var(--btn-primary)]"
            />
            Email + SMS each resident now
          </label>
        </div>
        <p className="flex items-center gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-foreground/60" data-attr="portfolio-import-invites-note">
          <PortalRowFact icon={AlertCircle}>Invites go out only when you say so</PortalRowFact>
        </p>
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="primary" loading={creating} onClick={() => onCreate(sendInvites)} data-attr="portfolio-import-create-everything">
          Create everything
        </Button>
      </div>
    </div>
  );
}
