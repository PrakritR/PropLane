"use client";

import { axisCatalogVendorById, formatVendorCatalogUsd, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { vendorCatalogDetailHref, type VendorDetailTabId } from "@/lib/portal-detail-routes";
import { BriefcaseBusiness, CircleDollarSign, Contact, Star, ArrowRight } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalNavigate } from "@/lib/portal-nav-client";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-12 border-b border-border py-2.5 text-[13.5px] last:border-b-0">
      <span className="font-semibold">{label}</span>
      <strong className="text-right font-semibold">{value}</strong>
    </div>
  );
}

function Preview({ icon: Icon, title, value, href, onNavigate }: { icon: typeof Contact; title: string; value: string; href?: string; onNavigate: (href: string) => void }) {
  return <div className="min-w-0 rounded-2xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2 font-semibold"><span className="flex min-w-0 items-center gap-2"><Icon className="h-4 w-4 shrink-0" aria-hidden />{title}</span>{href ? <PortalIconAction icon={ArrowRight} label={`View ${title.toLowerCase()}`} onClick={() => onNavigate(href)} /> : null}</div><p className="mt-3 break-words text-sm font-semibold">{value}</p></div>;
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
  const navigate = usePortalNavigate();
  if (!row) {
    return <div className="px-3 py-8 text-sm font-semibold" data-attr="vendor-catalog-missing">Couldn’t find that PropLane vendor.</div>;
  }
  return (
    <div className="space-y-4 px-3 pb-4 pt-3 sm:px-4" data-attr="vendor-catalog-detail">
      {tab === "overview" ? (
        <div className="space-y-4" data-attr="vendor-catalog-overview">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Preview icon={CircleDollarSign} title="Hourly" value={row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`} onNavigate={navigate} />
            <Preview icon={CircleDollarSign} title="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} onNavigate={navigate} />
            <Preview icon={BriefcaseBusiness} title="Your completed jobs" value="0" onNavigate={navigate} />
            <Preview icon={Star} title="Your job ratings" value="—" onNavigate={navigate} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Preview icon={Contact} title="Profile" value={row.trade} href={vendorCatalogDetailHref(basePath, detailId, "profile")} onNavigate={navigate} />
            <Preview icon={CircleDollarSign} title="Pricing" value={formatVendorCatalogUsd(row.serviceCents)} href={vendorCatalogDetailHref(basePath, detailId, "pricing")} onNavigate={navigate} />
            <Preview icon={BriefcaseBusiness} title="Jobs" value="No services yet" href={vendorCatalogDetailHref(basePath, detailId, "jobs")} onNavigate={navigate} />
            <Preview icon={Star} title="Reviews" value="No ratings from your jobs" href={vendorCatalogDetailHref(basePath, detailId, "reviews")} onNavigate={navigate} />
          </div>
        </div>
      ) : null}
      {tab === "profile" ? (
        <div className="grid gap-3 sm:grid-cols-2" data-attr="vendor-catalog-profile">
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">Business</h2><Field label="Trade" value={row.trade} />{row.city ? <Field label="Area" value={row.city} /> : null}</section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">Contact</h2><Field label="Phone" value={row.phone} /><Field label="Email" value={row.email} /></section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:col-span-2"><h2 className="font-semibold">About</h2><p className="pt-2 break-words text-sm">{row.description}</p></section>
        </div>
      ) : null}
      {tab === "pricing" ? (
        <div className="grid gap-3 sm:grid-cols-2" data-attr="vendor-catalog-pricing">
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">Published rates</h2><Field label="Hourly" value={row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`} /><Field label="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} /></section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">Your completed jobs</h2><Field label="Jobs" value="0" /><Field label="Final invoiced" value="—" /><Field label="Average final invoice" value="—" /></section>
        </div>
      ) : null}
      {(["jobs", "reviews", "check-ins", "communication", "documents", "activity"] as VendorDetailTabId[]).includes(tab) ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm" data-attr={`vendor-catalog-empty-${tab}`}>
          No {tab === "jobs" ? "services" : tab} are available for this catalog entry.
        </div>
      ) : null}
    </div>
  );
}
