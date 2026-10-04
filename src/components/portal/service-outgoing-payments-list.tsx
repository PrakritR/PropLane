"use client";

import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";

type Bucket = "to-pay" | "paid";
const TABS: Array<{ id: Bucket; label: string }> = [
  { id: "to-pay", label: "To pay" },
  { id: "paid", label: "Paid" },
];

/** What the manager pays vendors for one service: the standard band (To pay · Paid, search) over the Payments row. */
export function ServiceOutgoingPaymentsList({
  rows,
  busyId,
  onApproveAndPay,
}: {
  rows: readonly DemoManagerOutgoingPaymentRow[];
  busyId: string | null;
  onApproveAndPay: (row: DemoManagerOutgoingPaymentRow) => void;
}) {
  const [tab, setTab] = useState<Bucket>("to-pay");
  const [search, setSearch] = useState("");
  const inTab = (row: DemoManagerOutgoingPaymentRow, id: Bucket) => (id === "paid" ? row.bucket === "paid" : row.bucket !== "paid");
  const counts = useMemo(() => ({ "to-pay": rows.filter((r) => inTab(r, "to-pay")).length, paid: rows.filter((r) => inTab(r, "paid")).length }), [rows]);
  const shown = useMemo(
    () => rows.filter((row) => inTab(row, tab) && matchesPortalListSearch(search, row.payeeLabel, row.chargeTitle, row.categoryLabel, row.amountLabel)),
    [rows, tab, search],
  );
  return (
    <RecordListBand
      dataAttr="work-order-outgoing-payments"
      ariaLabel="Outgoing payment status"
      tabs={TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onChange={(id) => setTab(id as Bucket)}
      search={{ value: search, onChange: setSearch, placeholder: "Search payments" }}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() ? "No payments match" : tab === "paid" ? "Nothing paid yet" : "Nothing to pay"}
      emptySection="payments"
    >
      {shown.map((outgoing) => (
        <PortalApplicantRecordRow
          key={outgoing.id}
          name={outgoing.payeeLabel}
          address={[outgoing.chargeTitle, outgoing.categoryLabel].filter(Boolean).join(" · ")}
          facts={<PortalRowFact icon={CalendarDays}>{outgoing.bucket === "paid" ? `Paid ${outgoing.dueDate}` : outgoing.statusLabel}</PortalRowFact>}
          amount={outgoing.amountLabel}
          amountTone={outgoing.bucket === "paid" ? "ok" : outgoing.bucket === "overdue" ? "bad" : undefined}
          dataAttr="work-order-outgoing-row"
          actions={
            outgoing.bucket === "paid" ? undefined : (
              <Button
                type="button"
                variant="primary"
                className="h-7 rounded-full px-3 text-xs"
                data-attr="work-order-outgoing-approve-pay"
                disabled={busyId === outgoing.id}
                onClick={() => onApproveAndPay(outgoing)}
              >
                {busyId === outgoing.id ? "Opening…" : "Approve & pay"}
              </Button>
            )
          }
        />
      ))}
    </RecordListBand>
  );
}
