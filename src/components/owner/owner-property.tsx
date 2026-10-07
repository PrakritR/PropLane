"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerSummaryTiles } from "@/components/owner/owner-overview";
import { OwnerEmpty, OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type { OwnerSummary } from "@/lib/property-owner/projection";

const TH = "px-3 py-2 text-left text-xs font-semibold text-muted";
const TD = "px-3 py-2 text-sm tabular-nums";

/** Screen 4: one house. Money by month and units by status — never a resident. */
export function OwnerProperty({ propertyId }: { propertyId: string }) {
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>(`/api/owner/summary?propertyId=${encodeURIComponent(propertyId)}`);
  const router = useRouter();
  const property = data?.properties[0];
  return (
    <div data-attr="owner-property">
      <div className="mb-4 flex items-center gap-2">
        <PortalIconAction
          icon={ArrowLeft}
          label="Back to properties"
          data-attr="owner-back"
          onClick={() => router.push(`${OWNER_BASE_PATH}/properties`)}
        />
        <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">{property?.label ?? "Property"}</h1>
      </div>
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message={error === "Not found." ? "That property isn't available." : "Couldn't load this property."} onRetry={reload} />
      ) : !data || !property ? (
        <OwnerEmpty title="No activity yet" />
      ) : (
        <>
          <OwnerSummaryTiles summary={data} scope={property} />
          <div className="mb-4 overflow-x-auto rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold text-foreground">By month</p>
            <table className="mt-2 w-full min-w-[34rem]" data-attr="owner-month-table">
              <thead>
                <tr>
                  <th className={TH}>Month</th>
                  <th className={`${TH} text-right`}>Rent</th>
                  <th className={`${TH} text-right`}>Other income</th>
                  <th className={`${TH} text-right`}>Fees</th>
                  <th className={`${TH} text-right`}>Repairs &amp; services</th>
                  <th className={`${TH} text-right`}>Net</th>
                </tr>
              </thead>
              <tbody>
                {[...property.months].reverse().slice(0, 6).map((m) => (
                  <tr key={m.month} className="border-t border-border/50">
                    <td className="px-3 py-2 text-sm">{ownerMonthLabel(m.month)}</td>
                    <td className={`${TD} text-right`}>{formatOwnerUsd(m.rentCollectedCents)}</td>
                    <td className={`${TD} text-right`}>{formatOwnerUsd(m.otherIncomeCents)}</td>
                    <td className={`${TD} text-right`}>{formatOwnerUsd(m.feesCents)}</td>
                    <td className={`${TD} text-right`}>{formatOwnerUsd(m.repairsServicesCents)}</td>
                    <td className={`${TD} text-right font-semibold ${m.netCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>{formatOwnerUsd(m.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold text-foreground">Units</p>
            <table className="mt-2 w-full min-w-[22rem]" data-attr="owner-units-table">
              <thead>
                <tr>
                  <th className={TH}>Unit</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Rent</th>
                  <th className={TH}>Lease ends</th>
                </tr>
              </thead>
              <tbody>
                {(property.unitRows ?? []).map((u, i) => (
                  <tr key={`${u.unit}-${i}`} className="border-t border-border/50">
                    <td className="px-3 py-2 text-sm">{u.unit}</td>
                    <td className="px-3 py-2 text-sm">{u.status === "occupied" ? "Occupied" : "Vacant"}</td>
                    <td className={`${TD} text-right`}>{u.rentCents == null ? "—" : formatOwnerUsd(u.rentCents)}</td>
                    <td className="px-3 py-2 text-sm">{u.leaseEnd ? ownerMonthLabel(u.leaseEnd.slice(0, 7)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
