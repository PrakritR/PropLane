"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Repeat } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import type { ServiceIncomingRow } from "@/lib/service-incoming-payments";

type Bucket = "pending" | "overdue" | "paid";
const TABS: Array<{ id: Bucket; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
];

/**
 * Incoming payments for one service: the standard list band (Pending · Overdue · Paid, search) over
 * the Payments page's own row. A recurring add-on's cadence is a fact on its fee row.
 */
export function ServiceIncomingPaymentsList({ rows, onAddCharge }: { rows: readonly ServiceIncomingRow[]; onAddCharge?: () => void }) {
  const [tab, setTab] = useState<Bucket>("pending");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const { row } of rows) c[row.bucket] += 1;
    return c;
  }, [rows]);
  const shown = useMemo(
    () =>
      rows.filter(
        ({ row, recurringLabel }) =>
          row.bucket === tab &&
          (!type || (type === "recurring") === Boolean(recurringLabel)) &&
          matchesPortalListSearch(search, row.chargeTitle, row.residentName, row.propertyName, row.lineAmount),
      ),
    [rows, tab, search, type],
  );
  return (
    <RecordListBand
      dataAttr="service-incoming-payments"
      ariaLabel="Incoming payment status"
      tabs={TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts.overdue > 0 }))}
      activeId={tab}
      onChange={(id) => setTab(id as Bucket)}
      search={{ value: search, onChange: setSearch, placeholder: "Search charges" }}
      actions={
        <RecordBandFilter
          dataAttr="service-incoming-payments"
          fields={[
            {
              id: "type",
              label: "Type",
              anyLabel: "Any type",
              value: type,
              options: [
                { value: "recurring", label: "Recurring" },
                { value: "one-time", label: "One-time" },
              ],
              onChange: setType,
            },
          ]}
        />
      }
      plus={onAddCharge ? { label: "Add charge", onClick: onAddCharge, dataAttr: "service-incoming-add" } : undefined}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() || type ? "No charges match" : tab === "pending" ? "Nothing pending" : tab === "overdue" ? "Nothing overdue" : "Nothing paid yet"}
      emptySection="payments"
    >
      {shown.map(({ row, recurringLabel }) => (
        <PortalApplicantRecordRow
          key={row.id}
          name={row.residentName || "Resident"}
          address={[row.chargeTitle, row.propertyName].filter(Boolean).join(" · ")}
          facts={
            <>
              {row.dueDate ? <PortalRowFact icon={CalendarDays}>{row.dueDate}</PortalRowFact> : null}
              {recurringLabel ? <PortalRowFact icon={Repeat}>{recurringLabel}</PortalRowFact> : null}
            </>
          }
          amount={row.lineAmount}
          amountTone={row.bucket === "paid" ? "ok" : row.bucket === "overdue" ? "bad" : undefined}
          dataAttr="service-incoming-payment-row"
        />
      ))}
    </RecordListBand>
  );
}
