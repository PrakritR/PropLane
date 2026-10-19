"use client";

import { useState } from "react";
import { OwnerStatementsView } from "@/components/owner/owner-statements";
import { OwnerProfileView } from "@/components/owner/owner-profile-view";
import { OwnerEmpty, OwnerPageTitle } from "@/components/owner/owner-ui";
import { OwnerOverviewView, OwnerPropertiesListView } from "@/components/owner/owner-overview";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { ownerNavItems, type OwnerSectionId } from "@/lib/property-owner/sections";
import { homeOwnerSummary, homeOwnerStatementCsv, homeOwnerStatements } from "./home-dashboard-owner-data";

/** Real owner presentation over local, aggregate-only report fixtures. */
export default function HomeDashboardOwner() {
  const [section, setSection] = useState<OwnerSectionId>("statements");
  const [propertyId, setPropertyId] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [notice, setNotice] = useState("");
  const summary = homeOwnerSummary();
  const all = homeOwnerStatements();
  const data = homeOwnerStatements(propertyId);
  const navigate = (next: OwnerSectionId) => { setSection(next); setNotice(""); setSignedOut(false); };
  const download = (month: string) => {
    const blob = new Blob([homeOwnerStatementCsv(propertyId)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sample-owner-statement-${month}${propertyId ? `-${propertyId}` : ""}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser time to consume the download before releasing its local bytes.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Sample statement downloaded as CSV.");
  };

  return <div className="home-dashboard-owner" data-attr="home-owner-workspace">
    <aside aria-label="Owner sections">
      <div className="home-dashboard-owner-brand"><AxisLogoMark size="compact" />Owner</div>
      {ownerNavItems(false).map((item) => <button type="button" key={item.id} data-current={item.id === section} aria-current={item.id === section ? "page" : undefined} onClick={() => navigate(item.id)}><PortalNavIcon section={item.id} /><span>{item.label}</span></button>)}
    </aside>
    <div className="home-dashboard-owner-content">
      {signedOut ? <><OwnerEmpty title="Sample session ended" /><button type="button" className="mt-4 min-h-11 rounded-lg border border-border px-4 text-sm font-semibold" onClick={() => { setPropertyId(""); navigate("statements"); }}>Resume sample</button></> : <>
        {(section === "overview" || section === "properties") && <>
          <OwnerPageTitle>{section === "overview" ? "Overview" : "Properties"}</OwnerPageTitle>
          {section === "overview" ? <OwnerOverviewView data={summary} yearToDateKnown={false} rentDueKnown={false} chartPeriodLabel="September 2025" onDownload={() => navigate("statements")} onOpenProperty={(id) => { setPropertyId(id); navigate("statements"); }} /> : <OwnerPropertiesListView data={summary} rentDueKnown={false} onOpenProperty={(id) => { setPropertyId(id); navigate("statements"); }} />}
        </>}
        {section === "statements" && <OwnerStatementsView data={data} tabs={all.houses} propertyId={propertyId} onPropertyChange={(id) => { setPropertyId(id); setNotice(""); }} onDownload={download} />}
        {section === "documents" && <><OwnerPageTitle>Documents</OwnerPageTitle><OwnerEmpty title="No documents yet" /></>}
        {section === "profile" && <OwnerProfileView name={null} email={null} action={<button type="button" className="min-h-11 text-sm font-semibold text-red-600" onClick={() => setSignedOut(true)}>Sign out</button>} />}
      </>}
      {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    </div>
  </div>;
}
