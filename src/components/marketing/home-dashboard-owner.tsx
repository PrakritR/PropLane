"use client";

import { OwnerStatementsView } from "@/components/owner/owner-statements";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { ownerNavItems } from "@/lib/property-owner/sections";
import { homeOwnerStatements } from "./home-dashboard-owner-data";

const noop = () => {};
/** The owner's real statement rows, with only the report's allowed aggregate fields. */
export default function HomeDashboardOwner() {
  const data = homeOwnerStatements();
  return <div className="home-dashboard-owner" data-attr="home-owner-workspace">
    <aside><div className="home-dashboard-owner-brand"><AxisLogoMark size="compact" />Owner</div>
      {ownerNavItems(false).map((item) => <div key={item.id} data-current={item.id === "statements"}><PortalNavIcon section={item.id} /><span>{item.label}</span></div>)}
    </aside>
    <div className="home-dashboard-owner-content"><OwnerStatementsView data={data} tabs={data.houses} propertyId="" onPropertyChange={noop} onDownload={noop} /></div>
  </div>;
}
