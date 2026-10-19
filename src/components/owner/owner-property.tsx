"use client";

import { ArrowLeft, BedDouble, CalendarDays, DoorOpen, Hammer } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { ownerShortDay } from "@/components/owner/owner-overview";
import { OwnerEmpty, OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { KpiCard } from "@/components/portal/pro-dashboard-kpis";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type { OwnerPropertyDetail, OwnerServiceRow, OwnerSummary } from "@/lib/property-owner/projection";

type HouseTab = "rooms" | "services" | "months";

const TH = "px-3 py-2 text-left text-xs font-semibold text-muted";
const TD = "px-3 py-2 text-sm tabular-nums";

const SERVICE_STAGE_LABEL: Record<OwnerServiceRow["stage"], string> = { open: "Open", scheduled: "Scheduled", completed: "Completed" };

/** The listing's real photos, or one honest placeholder; a stock photo is never drawn. */
export function OwnerPhotoStrip({ photos, label }: { photos: readonly string[]; label: string }) {
  if (photos.length === 0) {
    return (
      <div className="h-36 overflow-hidden rounded-[10px] border border-border" data-attr="owner-photos-empty">
        <NoImagePlaceholder variant="compact" className="h-full w-full" />
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto rounded-[10px] [scrollbar-width:thin]" data-attr="owner-photos">
      {photos.map((src, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- listing photos live on the public storage host; the owner sees them as stored
        <img
          key={src}
          src={src}
          alt={`${label} photo ${index + 1}`}
          loading={index === 0 ? "eager" : "lazy"}
          className="h-36 w-auto max-w-none shrink-0 rounded-[10px] border border-border object-cover"
        />
      ))}
    </div>
  );
}

/** Screen: one house, read-only. Photos, the figures, then its rooms, services history and months. */
export function OwnerProperty({ propertyId }: { propertyId: string }) {
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>(`/api/owner/summary?propertyId=${encodeURIComponent(propertyId)}`);
  const detail = useOwnerFetch<OwnerPropertyDetail>(`/api/owner/properties/${encodeURIComponent(propertyId)}`);
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<HouseTab>(params?.get("tab") === "services" ? "services" : "rooms");
  const property = data?.properties[0];
  const services = detail.data?.services ?? [];
  const units = property?.unitRows ?? [];
  const months = property ? [...property.months].reverse().slice(0, 6) : [];
  const tabItems = [
    { id: "rooms", label: "Rooms", count: units.length },
    { id: "services", label: "Services", count: services.length },
    { id: "months", label: "Months", count: months.length },
  ];
  return (
    <div data-attr="owner-property" className="space-y-4">
      <div className="flex items-center gap-2">
        <PortalIconAction icon={ArrowLeft} label="Back to properties" data-attr="owner-back" onClick={() => router.push(`${OWNER_BASE_PATH}/properties`)} />
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground md:text-2xl">{property?.label ?? "Property"}</h1>
      </div>
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message={error === "Not found." ? "That property isn't available." : "Couldn't load this property."} onRetry={reload} />
      ) : !data || !property ? (
        <OwnerEmpty title="No activity yet" />
      ) : (
        <>
          <OwnerPhotoStrip photos={detail.data?.photos ?? []} label={property.label} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 [&>*]:min-w-0" data-attr="owner-property-kpis">
            <KpiCard
              label="Occupied"
              value={`${property.occupied} of ${property.units}`}
              href={`${OWNER_BASE_PATH}/properties/${encodeURIComponent(propertyId)}`}
              dataAttr="owner-property-kpi-occupied"
            />
            <KpiCard
              label={`Rent collected · ${ownerMonthLabel(data.period, true)}`}
              value={formatOwnerUsd(property.rentCollectedCents)}
              unit={`of ${formatOwnerUsd(property.rentDueCents)} due`}
              href={`${OWNER_BASE_PATH}/statements`}
              dataAttr="owner-property-kpi-rent"
            />
            <KpiCard label={`Net income · ${ownerMonthLabel(data.period, true)}`} value={formatOwnerUsd(property.netCents)} href={`${OWNER_BASE_PATH}/statements`} dataAttr="owner-property-kpi-net" />
            <KpiCard label={`Net income · ${data.period.slice(0, 4)}`} value={formatOwnerUsd(property.netYtdCents)} href={`${OWNER_BASE_PATH}/statements`} dataAttr="owner-property-kpi-ytd" />
          </div>
          <div>
            <div className="mb-2">
              <LocalDestinationNav
                items={tabItems.map((t) => ({ id: t.id, label: t.label, count: t.count, dataAttr: `owner-property-tab-${t.id}` }))}
                activeId={tab}
                onChange={(id) => setTab(id as HouseTab)}
                ariaLabel="Property"
                appearance="command"
              />
            </div>
            {tab === "rooms" ? (
              <PortalRecordListSurface dataAttr="owner-units-list" isEmpty={units.length === 0} emptyCard={{ title: "No rooms yet", section: "properties" }}>
                {units.map((u, i) => (
                  <PortalPropertyRecordRow
                    key={`${u.unit}-${i}`}
                    title={u.unit}
                    leading={<PortalRowIconTile icon={u.status === "occupied" ? BedDouble : DoorOpen} />}
                    leadingShape="square"
                    facts={
                      <>
                        <PortalRowFact icon={u.status === "occupied" ? BedDouble : DoorOpen} srLabel="Status" tone={u.status === "occupied" ? "ok" : undefined}>
                          {u.status === "occupied" ? "Occupied" : "Vacant"}
                        </PortalRowFact>
                        {u.leaseEnd ? (
                          <PortalRowFact icon={CalendarDays} srLabel="Lease ends">
                            Ends {ownerMonthLabel(u.leaseEnd.slice(0, 7))}
                          </PortalRowFact>
                        ) : null}
                      </>
                    }
                    amount={u.rentCents == null ? undefined : `${formatOwnerUsd(u.rentCents)}/mo`}
                    dataAttr="owner-unit-row"
                  />
                ))}
              </PortalRecordListSurface>
            ) : null}
            {tab === "services" ? (
              <PortalRecordListSurface
                dataAttr="owner-services-list"
                loading={detail.loading && !detail.data}
                isEmpty={services.length === 0}
                emptyCard={{ title: "No services yet", section: "services" }}
              >
                {services.map((s) => (
                  <PortalPropertyRecordRow
                    key={s.id}
                    title={s.title}
                    leading={<PortalRowIconTile icon={Hammer} />}
                    leadingShape="square"
                    facts={
                      <>
                        <PortalRowFact icon={Hammer} srLabel="Stage">
                          {SERVICE_STAGE_LABEL[s.stage]}
                        </PortalRowFact>
                        {s.date ? (
                          <PortalRowFact icon={CalendarDays} srLabel="Date">
                            {ownerShortDay(s.date)}
                          </PortalRowFact>
                        ) : null}
                      </>
                    }
                    amount={s.costCents == null ? undefined : formatOwnerUsd(s.costCents)}
                    dataAttr="owner-service-row"
                  />
                ))}
              </PortalRecordListSurface>
            ) : null}
            {tab === "months" ? (
              <div className="overflow-x-auto rounded-[10px] border border-border bg-card p-4">
                <table className="w-full min-w-[34rem]" data-attr="owner-month-table">
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
                    {months.map((m) => (
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
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
