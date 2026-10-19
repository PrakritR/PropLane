"use client";

import { ArrowLeft, CalendarDays, Download, Hammer, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { AmountFigure, KIND_ICON, TotalLine, shortDate } from "@/components/owner/owner-finances";
import { formatOwnerUsd, ownerMonthLabel, ownerServiceHref, useOwnerFetch } from "@/components/owner/owner-data";
import { ownerStatementPdfUrl } from "@/components/owner/owner-statements";
import { OwnerBand, OwnerEmpty, OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { useOwnerWorkspace } from "@/components/owner/owner-workspace";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import type { OwnerFinancesView } from "@/lib/managed-finance/finances.server";
import { parseOwnerPeriod, type OwnerSummary } from "@/lib/property-owner/projection";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";

function Header({ month, onPdf }: { month: string; onPdf?: () => void }) {
  const router = useRouter();
  return (
    <div className="mb-4 flex items-center gap-2">
      <PortalIconAction icon={ArrowLeft} label="Back to statements" data-attr="owner-statement-back" onClick={() => router.push(`${OWNER_BASE_PATH}/statements`)} />
      <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-foreground md:text-2xl">{ownerMonthLabel(month)} statement</h1>
      {onPdf ? <PortalIconAction icon={Download} label="Download PDF" data-attr="owner-statement-pdf" onClick={onPdf} /> : null}
    </div>
  );
}

function ManagedStatement({ view }: { view: OwnerFinancesView }) {
  const t = view.statement.totals;
  const deductions = view.statement.rows.filter((r) => r.kind === "vendor_charge");
  const withdrawals = view.statement.rows.filter((r) => r.kind === "withdrawal");
  return (
    <>
      <div className="mb-4 overflow-hidden rounded-[10px] border border-border bg-card" data-attr="owner-statement-totals">
        <TotalLine label="Gross rent" cents={t.rentGrossCents} />
        <TotalLine label="PropLane fee" cents={t.feeCents} />
        <TotalLine label="Repairs and vendors" cents={t.vendorChargesCents} />
        {t.otherCents !== 0 ? <TotalLine label="Adjustments" cents={t.otherCents} /> : null}
        <TotalLine label="Net to you" cents={t.netCents} strong />
        <TotalLine label="Withdrawals" cents={t.withdrawalsCents} />
        <TotalLine label="Ending balance" cents={view.statement.endingCents} strong />
      </div>
      {deductions.length > 0 ? (
        <div className="mb-4" data-attr="owner-statement-deductions">
          <OwnerBand label="Repairs and vendors" count={deductions.length} />
          <PortalRecordListSurface dataAttr="owner-statement-deductions-list">
            {deductions.map((row) => {
              const href = ownerServiceHref(row.propertyId);
              const Icon = KIND_ICON[row.kind] ?? Hammer;
              return (
                <PortalPropertyRecordRow
                  key={row.id}
                  title={row.label}
                  address={(row as { propertyLabel?: string | null }).propertyLabel ?? undefined}
                  leading={<PortalRowIconTile icon={Icon} />}
                  leadingShape="square"
                  facts={
                    <PortalRowFact icon={CalendarDays} srLabel="Date">
                      {shortDate(row.date)}
                    </PortalRowFact>
                  }
                  actions={<AmountFigure cents={row.amountCents} />}
                  onOpen={href ? () => window.location.assign(href) : undefined}
                  dataAttr={`owner-statement-deduction-${row.id}`}
                />
              );
            })}
          </PortalRecordListSurface>
        </div>
      ) : null}
      {withdrawals.length > 0 ? (
        <div data-attr="owner-statement-withdrawals">
          <OwnerBand label="Withdrawals" count={withdrawals.length} />
          <PortalRecordListSurface dataAttr="owner-statement-withdrawals-list">
            {withdrawals.map((row) => (
              <PortalPropertyRecordRow
                key={row.id}
                title={row.label}
                leading={<PortalRowIconTile icon={Wallet} />}
                leadingShape="square"
                facts={
                  <PortalRowFact icon={CalendarDays} srLabel="Date">
                    {shortDate(row.date)}
                  </PortalRowFact>
                }
                actions={<AmountFigure cents={row.amountCents} />}
                dataAttr={`owner-statement-withdrawal-${row.id}`}
              />
            ))}
          </PortalRecordListSurface>
        </div>
      ) : null}
    </>
  );
}

/** A workspace PropLane does not hold funds for: the month's figures straight from the same reports the manager reads. */
function PlainStatement({ summary, month }: { summary: OwnerSummary; month: string }) {
  const houses = summary.properties
    .map((p) => ({ p, row: p.months.find((m) => m.month === month) }))
    .filter((h): h is { p: (typeof summary.properties)[number]; row: NonNullable<typeof h.row> } => Boolean(h.row));
  const sum = (pick: (row: (typeof houses)[number]["row"]) => number) => houses.reduce((n, h) => n + pick(h.row), 0);
  return (
    <>
      <div className="mb-4 overflow-hidden rounded-[10px] border border-border bg-card" data-attr="owner-statement-totals">
        <TotalLine label="Rent collected" cents={sum((r) => r.rentCollectedCents)} />
        <TotalLine label="Other income" cents={sum((r) => r.otherIncomeCents)} />
        <TotalLine label="Processing fees" cents={-sum((r) => r.feesCents)} />
        <TotalLine label="Repairs and services" cents={-sum((r) => r.repairsServicesCents)} />
        <TotalLine label="Net to you" cents={sum((r) => r.netCents)} strong />
      </div>
      {houses.length > 0 ? (
        <PortalRecordListSurface dataAttr="owner-statement-houses-list">
          {houses.map(({ p, row }) => (
            <PortalPropertyRecordRow
              key={p.propertyId}
              title={p.label}
              leading={<PortalRowIconTile icon={Hammer} />}
              leadingShape="square"
              facts={
                <PortalRowFact icon={Wallet} srLabel="Rent collected">
                  {formatOwnerUsd(row.rentCollectedCents)} collected
                </PortalRowFact>
              }
              amount={formatOwnerUsd(row.netCents)}
              amountTone={row.netCents < 0 ? "bad" : undefined}
              onOpen={() => window.location.assign(`${OWNER_BASE_PATH}/properties/${encodeURIComponent(p.propertyId)}`)}
              dataAttr={`owner-statement-house-${p.propertyId}`}
            />
          ))}
        </PortalRecordListSurface>
      ) : null}
    </>
  );
}

/** One statement month: gross rent, PropLane fee, vendor and maintenance deductions, net, withdrawals and the ending balance. */
export function OwnerStatementDetail({ month }: { month: string }) {
  const workspace = useOwnerWorkspace();
  const valid = parseOwnerPeriod(month);
  const managedId = workspace?.active?.managed ? workspace.active.id : null;
  const finances = useOwnerFetch<OwnerFinancesView>(valid && managedId ? `/api/owner/finances?workspace=${encodeURIComponent(managedId)}&month=${encodeURIComponent(valid)}` : null);
  const summary = useOwnerFetch<OwnerSummary>(valid && !managedId ? `/api/owner/summary?period=${encodeURIComponent(valid)}` : null);
  if (!valid) {
    return (
      <div data-attr="owner-statement">
        <Header month={month.length === 7 ? month : "0000-00"} />
        <OwnerEmpty title="No statement for that month" />
      </div>
    );
  }
  const active = managedId ? finances : summary;
  const view = managedId ? finances.data : null;
  return (
    <div data-attr="owner-statement">
      <Header month={valid} onPdf={() => window.location.assign(ownerStatementPdfUrl(valid, "", workspace?.activeId ?? null, Boolean(managedId)))} />
      {active.loading && !active.data ? (
        <OwnerLoading />
      ) : active.error ? (
        <OwnerError message="Couldn't load this statement." onRetry={active.reload} />
      ) : view ? (
        <ManagedStatement view={view} />
      ) : summary.data ? (
        <PlainStatement summary={summary.data} month={valid} />
      ) : (
        <OwnerEmpty title="No statement for that month" />
      )}
    </div>
  );
}
