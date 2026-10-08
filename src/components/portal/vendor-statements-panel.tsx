"use client";

/**
 * Vendor Finances → Statements (vendor-banking-1006, part A): one row per month
 * with activity — opening and closing balance and whether it matches Stripe —
 * each opening the month's full statement (every ledger event type, PDF + CSV).
 * A failed read is a real error with Retry, never an empty list.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Download, FileText } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import { VendorStatementModal, formatStatementUsd } from "@/components/portal/vendor-statement-modal";
import type { StatementMonthSummary } from "@/lib/vendor-banking/statement-events";

type StatementsPayload = {
  months: StatementMonthSummary[];
  reconciliation: { matches: boolean; reconciledAt: string } | null;
};

/** The page shell, or nothing when the panel sits inside another page (Documents > Statements). */
function StatementsShell({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  if (embedded) return <div data-attr="vendor-statements-embedded">{children}</div>;
  return (
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
      {children}
    </ManagerPortalPageShell>
  );
}

export function VendorStatementsPanel({ basePath, embedded = false }: { basePath: string; embedded?: boolean }) {
  const [data, setData] = useState<StatementsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/vendor/payouts/statement?summary=1", { credentials: "include" });
      if (!res.ok) throw new Error("statements unavailable");
      const body = (await res.json()) as Partial<StatementsPayload>;
      if (!Array.isArray(body.months)) throw new Error("malformed");
      setData({ months: body.months, reconciliation: body.reconciliation ?? null });
      setState("ready");
    } catch {
      setData(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const months = data?.months ?? [];

  return (
    <StatementsShell embedded={embedded}>
      {embedded ? null : <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={[
          {
            id: "statements",
            label: "Statements",
            count: state === "ready" ? months.length : undefined,
            href: `${basePath}/documents/statements`,
            dataAttr: "vendor-statements-tab",
          },
        ]}
        activeDestinationId="statements"
        destinationAriaLabel="Statements"
        actions={
          <PortalIconAction
            icon={Download}
            label="Export all activity CSV"
            data-attr="vendor-statements-export-all"
            disabled={state !== "ready" || months.length === 0}
            onClick={() => window.open("/api/vendor/payouts/statement?format=csv", "_blank", "noopener")}
          />
        }
      />}
      <PortalRecordListSurface
        loading={state === "loading"}
        loadError={state === "error" ? "Could not load your statements." : undefined}
        onRetry={() => void load()}
        isEmpty={state === "ready" && months.length === 0}
        emptyCard={{ title: "No statements yet", section: "financials", tone: "muted" }}
        dataAttr="vendor-statements-list"
      >
        {months.map((month) => (
          <PortalPropertyRecordRow
            key={month.month}
            title={month.label}
            leading={
              <span className="grid size-14 place-items-center rounded-xl bg-accent text-primary" aria-hidden>
                <FileText className="size-5" />
              </span>
            }
            leadingShape="square"
            facts={
              <>
                <span>Opening {formatStatementUsd(month.openingCents)}</span>
                <span>Closing {formatStatementUsd(month.closingCents)}</span>
                {data?.reconciliation ? <span>{data.reconciliation.matches ? "Matches Stripe" : "Reconciling"}</span> : null}
                <PortalRowFact icon={FileText} srLabel="Lines">{month.lineCount} lines</PortalRowFact>
              </>
            }
            actions={
              <VendorRowMenu
                label={month.label}
                dataAttr="vendor-statement-row-menu"
                items={[
                  { id: "view", label: "View statement", onSelect: () => setOpenMonth(month.month) },
                  {
                    id: "pdf",
                    label: "Download PDF",
                    onSelect: () => window.open(`/print/vendor-statement/${encodeURIComponent(month.month)}`, "_blank", "noopener"),
                  },
                  {
                    id: "csv",
                    label: "Download CSV",
                    onSelect: () => window.open(`/api/vendor/payouts/statement?format=csv&month=${encodeURIComponent(month.month)}`, "_blank", "noopener"),
                  },
                ]}
              />
            }
            onOpen={() => setOpenMonth(month.month)}
            dataAttr="vendor-statement-month-row"
          />
        ))}
      </PortalRecordListSurface>
      {openMonth ? <VendorStatementModal open onClose={() => setOpenMonth(null)} month={openMonth} /> : null}
    </StatementsShell>
  );
}
