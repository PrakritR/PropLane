"use client";

/**
 * The Tours, Applications and Leases pop-ups, record pages and Filter popovers, loaded on demand. A pop-up only
 * exists after a click, so none of them (nor the real wizard and filter pieces they draw with) is in the home page's
 * first load: each is a `next/dynamic` import of `demo-popups-leasing.tsx`, the same way `demo-popups-lazy.tsx`
 * loads the Forms ones. `ssr: false` because nothing here renders before a click. Until a Filter popover's chunk
 * arrives the header draws the same Filter icon (inert), so nothing jumps.
 */

import dynamic from "next/dynamic";
import { DemoPopupLoading, DemoSampleLoading } from "./demo-sample-loading";
import { Filter } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

const leasing = () => import("@/components/marketing/site/product-mock/demo-popups-leasing");

/**
 * Starts loading the chunk once a Tours / Applications / Leases panel is on screen (not before: the first load never
 * carries it), so the hero's cursor, which clicks Send application and a lease row within a second or two of the tab
 * opening, finds the pop-up or record ready.
 */
export function prefetchLeasingPopups() {
  void leasing();
}

const filterFallback = () => <PortalIconAction icon={Filter} label="Filter" />;

export const DemoToursFilter = dynamic(() => leasing().then((m) => m.DemoToursFilter), { ssr: false, loading: filterFallback });
export const DemoApplicationsFilter = dynamic(() => leasing().then((m) => m.DemoApplicationsFilter), { ssr: false, loading: filterFallback });
export const DemoLeasesFilter = dynamic(() => leasing().then((m) => m.DemoLeasesFilter), { ssr: false, loading: filterFallback });

export const DemoNotifyPopup = dynamic(() => leasing().then((m) => m.DemoNotifyPopup), { ssr: false, loading: DemoPopupLoading });

export const DemoTourAvailabilityPopup = dynamic(() => leasing().then((m) => m.DemoTourAvailabilityPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoShareLinkPopup = dynamic(() => leasing().then((m) => m.DemoShareLinkPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoAddTourPopup = dynamic(() => leasing().then((m) => m.DemoAddTourPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoTourRecord = dynamic(() => leasing().then((m) => m.DemoTourRecord), { ssr: false, loading: DemoSampleLoading });

export const DemoAddApplicationPopup = dynamic(() => leasing().then((m) => m.DemoAddApplicationPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoApplicationRecord = dynamic(() => leasing().then((m) => m.DemoApplicationRecord), { ssr: false, loading: DemoSampleLoading });

export const DemoSendLeasePopup = dynamic(() => leasing().then((m) => m.DemoSendLeasePopup), { ssr: false, loading: DemoPopupLoading });
export const DemoLeaseRecord = dynamic(() => leasing().then((m) => m.DemoLeaseRecord), { ssr: false, loading: DemoSampleLoading });
