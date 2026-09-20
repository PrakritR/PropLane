"use client";

import { axisCatalogVendorById, formatVendorCatalogUsd, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { vendorCatalogDetailHref, type VendorDetailTabId } from "@/lib/portal-detail-routes";
import { BriefcaseBusiness, CircleDollarSign, Contact, Star, ArrowRight } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-12 border-b border-border py-2.5 text-[13.5px] last:border-b-0">
      <span className="font-semibold">{label}</span>
      <strong className="text-right font-semibold">{value}</strong>
    </div>
  );
}

function Preview({ icon: Icon, title, value, href }: { icon: typeof Contact; title: string; value: string; href?: string }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2 font-semibold"><span className="flex items-center gap-2"><Icon className="h-4 w-4" aria-hidden />{title}</span>{href ? <PortalIconAction icon={ArrowRight} label={`View ${title.toLowerCase()}`} onClick={() => { window.location.href = href; }} /> : null}</div><p className="mt-3 text-sm font-semibold">{value}</p></div>;
}

export function ManagerVendorCatalogDetail({
  catalogId,
  vendor,
  tab,
  basePath = "/portal",
}: {
  catalogId?: string;
  vendor?: AxisCatalogVendor | null;
  tab: VendorDetailTabId;
  basePath?: string;
}) {
  const row = vendor ?? axisCatalogVendorById(catalogId ?? "");
  const detailId = catalogId ?? "";
  if (!row) {
    return <div className="px-3 py-8 text-sm font-semibold" data-attr="vendor-catalog-missing">Couldn’t find that PropLane vendor.</div>;
  }
  return (
    <div className="space-y-4 px-3 pb-4 pt-3 sm:px-4" data-attr="vendor-catalog-detail">
      {tab === "overview" ? (
        <div className="space-y-4" data-attr="vendor-catalog-overview">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Preview icon={CircleDollarSign} title="Hourly" value={row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`} />
            <Preview icon={CircleDollarSign} title="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} />
            <Preview icon={BriefcaseBusiness} title="Your completed jobs" value="0" />
            <Preview icon={Star} title="Your job ratings" value="—" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Preview icon={Contact} title="Profile" value={row.trade} href={vendorCatalogDetailHref(basePath, detailId, "profile")} />
            <Preview icon={CircleDollarSign} title="Pricing" value={formatVendorCatalogUsd(row.serviceCents)} href={vendorCatalogDetailHref(basePath, detailId, "pricing")} />
            <Preview icon={BriefcaseBusiness} title="Jobs" value="No services yet" href={vendorCatalogDetailHref(basePath, detailId, "jobs")} />
            <Preview icon={Star} title="Reviews" value="No ratings from your jobs" href={vendorCatalogDetailHref(basePath, detailId, "reviews")} />
          </div>
        </div>
      ) : null}
      {tab === "profile" ? (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]" data-attr="vendor-catalog-profile">
          <div className="grid gap-3 sm:grid-cols-2"><div><h2 className="font-semibold">Business</h2><Field label="Trade" value={row.trade} />{row.city ? <Field label="Area" value={row.city} /> : null}</div><div><h2 className="font-semibold">Contact</h2><Field label="Phone" value={row.phone} /><Field label="Email" value={row.email} /></div></div>
          <div className="pt-4"><h2 className="font-semibold">About</h2><p className="pt-2 text-sm">{row.description}</p></div>
        </div>
      ) : null}
      {tab === "pricing" ? (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]" data-attr="vendor-catalog-pricing">
          <Field label="Hourly" value={row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`} />
          <Field label="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} />
          <Field label="Your completed jobs" value="0" />
          <Field label="Final invoiced" value="—" />
          <Field label="Average" value="—" />
        </div>
      ) : null}
      {(["jobs", "reviews", "check-ins", "communication"] as VendorDetailTabId[]).includes(tab) ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm" data-attr={`vendor-catalog-empty-${tab}`}>
          No {tab === "jobs" ? "services" : tab} are available for this catalog entry.
        </div>
      ) : null}
    </div>
  );
}
