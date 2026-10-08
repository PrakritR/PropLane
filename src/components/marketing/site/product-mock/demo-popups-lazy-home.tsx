"use client";

/**
 * The Properties and Calendar pop-ups and record pages, loaded on demand. A pop-up only exists after a click,
 * so none of them (nor the real wizard behind them) is in the home page's first load: each is a `next/dynamic`
 * chunk with `ssr: false`, the same way `demo-popups-lazy.tsx` does it.
 */

import dynamic from "next/dynamic";

const home = () => import("@/components/marketing/site/product-mock/demo-popups-home");

export const DemoNewPropertyPopup = dynamic(() => home().then((m) => m.DemoNewPropertyPopup), { ssr: false });
export const DemoShareListingPopup = dynamic(() => home().then((m) => m.DemoShareListingPopup), { ssr: false });
export const DemoPropertyRecord = dynamic(() => home().then((m) => m.DemoPropertyRecord), { ssr: false });
export const DemoAddTourPopup = dynamic(() => home().then((m) => m.DemoAddTourPopup), { ssr: false });
export const DemoAddTaskPopup = dynamic(() => home().then((m) => m.DemoAddTaskPopup), { ssr: false });
export const DemoAddServicePopup = dynamic(() => home().then((m) => m.DemoAddServicePopup), { ssr: false });
export const DemoAvailabilityPopup = dynamic(() => home().then((m) => m.DemoAvailabilityPopup), { ssr: false });
export const DemoCalendarRecord = dynamic(() => home().then((m) => m.DemoCalendarRecord), { ssr: false });

/** The Calendar Filter popover's one field (Property), inside the lazily loaded sheet. */
export const DemoCalendarFilterFields = dynamic(
  () => import("@/components/portal/application-filter-sort-fields").then((m) => m.ApplicationFilterSortFields),
  { ssr: false },
);
