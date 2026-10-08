"use client";

/**
 * Finances -> Refunds (vendor-banking-1006): the vendor's refund requests, newest first, on the
 * shared list surface and row anatomy (tile · title · place · glyph facts · figure · ⋯, no pills).
 * Pending / Succeeded / Failed are glyph facts, never a pill. The Finances shell (another
 * module) mounts this by `basePath`; the round + opens the "Refund a payment" pop-up.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarDays, Check, Clock, Undo2, UserRound } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { VendorRefundModal } from "@/components/portal/vendor-refund-modal";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import type { VendorRefundListItem } from "@/lib/vendor-banking/central-refund.server";

type Refund = Omit<VendorRefundListItem, never>;

const STATUS_FACT = {
  pending: { icon: Clock, text: "Pending" },
  succeeded: { icon: Check, text: "Refunded" },
  failed: { icon: AlertCircle, text: "Failed" },
} as const;

function formatUsd(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function VendorRefundsPanel(props: {
  basePath: string;
  /** A tab of the Finances page: the page's header card owns the round + and the padding. */
  embedded?: boolean;
  /** Bumped by the page's + to open the "Refund a payment" pop-up. */
  addRequest?: number;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const { basePath, embedded = false, addRequest = 0, onEnabledChange } = props;
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/refunds", { credentials: "include" });
      const body = (await res.json().catch(() => null)) as { refunds?: Refund[]; enabled?: boolean } | null;
      if (!res.ok || !body) {
        setState("error");
        return;
      }
      setRefunds(body.refunds ?? []);
      setEnabled(Boolean(body.enabled));
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onEnabledChange?.(enabled);
  }, [enabled, onEnabledChange]);

  const lastAddRequest = useRef(addRequest);
  useEffect(() => {
    if (addRequest !== lastAddRequest.current) {
      lastAddRequest.current = addRequest;
      if (enabled) setModalOpen(true);
    }
  }, [addRequest, enabled]);

  if (state === "loading") return <p className="py-10 text-center text-sm">Loading refunds…</p>;
  if (state === "error") return <p className="py-10 text-center text-sm">Could not load refunds.</p>;

  return (
    <div className={embedded ? "pb-6" : "px-3 pb-6 sm:px-4"} data-attr="vendor-refunds-panel" data-base-path={basePath}>
      <PortalRecordListSurface
        isEmpty={!refunds || refunds.length === 0}
        emptyCard={{ title: "No refunds yet", section: "payments", tone: "muted" }}
        add={enabled ? { ariaLabel: "Refund a payment", onClick: () => setModalOpen(true), dataAttr: "vendor-refunds-add" } : undefined}
        dataAttr="vendor-refunds-list"
      >
        {(refunds ?? []).map((refund) => {
          const status = STATUS_FACT[refund.status];
          return (
            <PortalPropertyRecordRow
              key={refund.id}
              title={refund.paymentLabel}
              leading={<PortalRowIconTile icon={Undo2} />}
              leadingShape="square"
              facts={
                <>
                  <PortalRowFact icon={UserRound} srLabel="Manager">
                    {refund.managerLabel}
                  </PortalRowFact>
                  <PortalRowFact icon={CalendarDays} srLabel="Date">
                    {formatDate(refund.createdAt)}
                  </PortalRowFact>
                  <PortalRowFact icon={status.icon} srLabel="Status" tone={refund.status === "failed" ? "danger" : undefined}>
                    {status.text}
                  </PortalRowFact>
                </>
              }
              amount={formatUsd(refund.grossCents)}
              dataAttr="vendor-refund-row"
              actions={
                <VendorRowMenu
                  label={refund.paymentLabel}
                  dataAttr="vendor-refund-menu"
                  items={[{ id: "refresh", label: "Refresh status", onSelect: () => void load() }]}
                />
              }
            />
          );
        })}
      </PortalRecordListSurface>
      <VendorRefundModal open={modalOpen} onClose={() => setModalOpen(false)} onDone={() => void load()} />
    </div>
  );
}
