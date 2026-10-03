"use client";

import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { formatResidentShortDate } from "@/lib/manager-resident-lifecycle";

function signerStatus(sig: { name?: string; signedAtIso?: string } | null | undefined): {
  label: string;
  detail: string;
} {
  if (sig?.name && sig.signedAtIso) {
    return {
      label: "Signed",
      detail: formatResidentShortDate(sig.signedAtIso) || sig.signedAtIso,
    };
  }
  return { label: "Waiting", detail: "—" };
}

export function ManagerResidentLeaseSigners({ row }: { row: LeasePipelineRow }) {
  const parties = [
    {
      id: "manager",
      party: row.managerSignature?.name?.trim() || "Manager",
      role: "Landlord / agent",
      sig: row.managerSignature,
    },
    {
      id: "resident",
      party: row.residentSignature?.name?.trim() || row.residentName?.trim() || "Resident",
      role: "Resident",
      sig: row.residentSignature ?? (row.signatureName && row.signedAtIso
        ? { name: row.signatureName, signedAtIso: row.signedAtIso, role: "resident" as const }
        : null),
    },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-border/80 bg-card" data-er="signers">
      <ul className="divide-y divide-border/70">
        {parties.map((p) => {
          const status = signerStatus(p.sig);
          return (
            <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{p.party}</p>
                <p className="text-[13px] text-muted">{p.role}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold text-foreground">{status.label}</p>
                <p className="text-[13px] text-muted tabular-nums">{status.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
