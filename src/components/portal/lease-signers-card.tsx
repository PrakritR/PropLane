"use client";

/**
 * Who signed — a lease record's compact signature strip, one card, one line:
 *
 *   Who signed   Resident  Casey Morgan  Sent Sep 24  (bell)     You  Alex Rivera  Waiting  [Sign]
 *
 * It replaces the Signatures card and the Signatures/Status tiles that repeated the same
 * facts. On a joint shared-room lease every roommate is a part of the strip, and the manager
 * can sign only once each of them has. It wraps on a phone instead of scrolling sideways.
 */
import { Bell, Check, Clock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { leaseSignerRows, type LeaseSignerRow } from "@/lib/lease-signers";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function shortDay(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function factFor(row: LeaseSignerRow): { icon: typeof Check; text: string } {
  if (row.state === "signed") return { icon: Check, text: `Signed ${shortDay(row.at)}`.trim() };
  if (row.state === "sent") return { icon: Send, text: `Sent ${shortDay(row.at)}`.trim() };
  return { icon: Clock, text: "Waiting" };
}

export function LeaseSignersCard({
  row,
  siblings,
  managerName,
  onRemind,
  onSign,
  remindBusyLeaseId,
}: {
  row: LeasePipelineRow;
  siblings?: LeasePipelineRow[];
  managerName?: string;
  /** Omit on a read-only view (the resident record): the bell is not drawn. */
  onRemind?: (leaseId: string) => void;
  /** Omit on a read-only view: the Sign button is not drawn. */
  onSign?: () => void;
  remindBusyLeaseId?: string | null;
}) {
  const rows = leaseSignerRows(row, { managerName, siblings });
  if (rows.length === 0) return null;
  return (
    <section
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm"
      data-attr="lease-signers"
      aria-label="Who signed"
    >
      <h3 className="text-[14px] font-extrabold text-foreground">Who signed</h3>
      {rows.map((r) => {
        const fact = factFor(r);
        const Icon = fact.icon;
        return (
          <div key={r.id} className="flex min-w-0 items-center gap-2 text-[13.5px]" data-attr={`lease-signer-${r.role.toLowerCase()}`}>
            <span className="text-muted">{r.role}</span>
            <span className="min-w-0 truncate font-bold text-foreground">{r.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-muted">
              <Icon className="size-3.5" strokeWidth={1.6} aria-hidden />
              {fact.text}
            </span>
            {r.action === "remind" && onRemind ? (
              <PortalIconAction
                icon={Bell}
                label={`Remind ${r.name.split(/\s+/)[0] ?? ""}`.trim()}
                data-attr="lease-signer-remind"
                disabled={remindBusyLeaseId === r.leaseId}
                onClick={() => onRemind(r.leaseId)}
              />
            ) : null}
            {r.action === "sign" && onSign ? (
              <Button type="button" variant="outline" className="shrink-0 rounded-full" data-attr="lease-signer-sign" onClick={onSign}>
                Sign
              </Button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
