"use client";

/**
 * Shared room — the card an application in a multi-bed room shows: room, bed, rent, lease
 * type and beds taken, then every roommate's status with an Approve or Remind icon of their
 * own. Approving is per resident; a group never blocks.
 */
import { Bell, Check, Clock, UserRound } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import type { SharedRoomCardModel } from "@/lib/shared-room-card";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="min-w-0 text-right text-[13.5px]">{children}</span>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

export function SharedRoomCard({
  model,
  onApprove,
  onRemind,
}: {
  model: SharedRoomCardModel;
  onApprove: (applicationId: string) => void;
  onRemind: (applicationId: string) => void;
}) {
  const applied = model.roommates.length;
  const declared = applied + model.notApplied;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" data-sr-shared-card data-attr="shared-room-card" aria-label="Shared room">
      <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold text-foreground">Shared room</h3>
      <div className="px-4">
        <Row label="Room">{`${model.roomName} · Shared · ${model.capacity} beds`}</Row>
        <Row label="Bed">{model.bedLabel ? `${model.bedLabel}${model.bedRequested ? " (requested)" : ""}` : "Not chosen yet"}</Row>
        <Row label="Rent">{model.rentLabel ?? "Not set"}</Row>
        <Row label="Lease">{model.leaseLabel}</Row>
        <Row label="Beds taken">{`${model.taken} of ${model.capacity}`}</Row>
      </div>
      {model.roommates.length > 1 || model.notApplied > 0 ? (
        <div className="border-t border-border/70 px-4 pb-1 pt-3" data-attr="shared-room-roommates">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {declared > 0 ? `Roommates · ${applied} of ${declared} applied` : "Roommates"}
          </p>
          <ul className="divide-y divide-border/60">
            {model.roommates.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2.5" data-attr="shared-room-roommate">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-[12px] font-bold text-foreground">
                  {initials(m.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold leading-tight text-foreground">{m.name}</p>
                  <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
                    <span className="inline-flex items-center gap-1">
                      {m.approved ? <Check className="size-3.5" strokeWidth={1.6} aria-hidden /> : <Clock className="size-3.5" strokeWidth={1.6} aria-hidden />}
                      {m.statusWord}
                    </span>
                    {m.bedLabel ? <span>{m.bedLabel}</span> : null}
                    {m.rentLabel ? <span>{m.rentLabel}</span> : null}
                    {m.isThis ? <span>This application</span> : null}
                  </p>
                </div>
                {m.action === "approve" ? (
                  <PortalIconAction icon={Check} label={m.isThis ? "Approve" : `Approve ${m.name.split(/\s+/)[0]}`} data-attr="shared-room-approve" onClick={() => onApprove(m.id)} />
                ) : m.action === "remind" ? (
                  <PortalIconAction icon={Bell} label={`Remind ${m.name.split(/\s+/)[0]}`} data-attr="shared-room-send-reminder" onClick={() => onRemind(m.id)} />
                ) : null}
              </li>
            ))}
            {model.notApplied > 0 ? (
              <li className="flex items-center gap-3 py-2.5" data-attr="shared-room-not-applied">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-muted">
                  <UserRound className="size-4" aria-hidden />
                </span>
                <p className="min-w-0 flex-1 text-[13.5px] text-muted">
                  {model.notApplied === 1 ? "1 roommate has not applied yet" : `${model.notApplied} roommates have not applied yet`}
                </p>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
