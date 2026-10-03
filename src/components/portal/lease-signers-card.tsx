"use client";

/**
 * Who has signed — a lease record's compact signature strip.
 *
 *   Resident · Casey Morgan   Sent Sep 24  (🔔 Remind)   /   Signed Sep 29
 *   You · Alex Rivera         Waiting      [Sign]
 *
 * It replaces the Signatures card and the Signatures/Status tiles that repeated the same
 * facts. On a joint shared-room lease every roommate is a row of their own, and the manager
 * can sign only once each of them has.
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
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
  onRemind: (leaseId: string) => void;
  onSign: () => void;
  remindBusyLeaseId?: string | null;
}) {
  const rows = leaseSignerRows(row, { managerName, siblings });
  if (rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" data-attr="lease-signers" aria-label="Who has signed">
      <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold text-foreground">Who has signed</h3>
      <ul className="divide-y divide-border/60">
        {rows.map((r) => {
          const fact = factFor(r);
          const Icon = fact.icon;
          return (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3" data-attr={`lease-signer-${r.role.toLowerCase()}`}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-[13px] font-bold text-foreground">
                {initials(r.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-tight text-foreground">{r.role}</p>
                <p className="truncate text-[13px] text-muted">{r.name}</p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-muted">
                <Icon className="size-3.5" strokeWidth={1.6} aria-hidden />
                {fact.text}
              </span>
              {r.action === "remind" ? (
                <PortalIconAction
                  icon={Bell}
                  label={`Remind ${r.name.split(/\s+/)[0] ?? ""}`.trim()}
                  data-attr="lease-signer-remind"
                  disabled={remindBusyLeaseId === r.leaseId}
                  onClick={() => onRemind(r.leaseId)}
                />
              ) : null}
              {r.action === "sign" ? (
                <Button type="button" variant="outline" className="shrink-0 rounded-full" data-attr="lease-signer-sign" onClick={onSign}>
                  Sign
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
