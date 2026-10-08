"use client";

/**
 * The home demo's pop-ups, loaded on demand. A pop-up only exists after a click, so none of them (nor the real
 * wizard pieces they draw with) is in the home page's first load: each is its own `next/dynamic` chunk, the same
 * way the role Dashboards are (`demo-panels.tsx`). `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";

const forms = () => import("@/components/marketing/site/product-mock/demo-popups-forms");
const record = () => import("@/components/marketing/site/product-mock/demo-record");

/** A record page (what a row opens in the real portal): header, icon actions, section rail, body. */
export const DemoRecordPage = dynamic(() => record().then((m) => m.DemoRecordPage), { ssr: false });
export const DemoRecordThread = dynamic(() => record().then((m) => m.DemoRecordThread), { ssr: false });

export const DemoSendFormPopup = dynamic(() => forms().then((m) => m.DemoSendFormPopup), { ssr: false });
export const DemoFormViewerPopup = dynamic(() => forms().then((m) => m.DemoFormViewerPopup), { ssr: false });
export const DemoEditPendingFormPopup = dynamic(() => forms().then((m) => m.DemoEditPendingFormPopup), { ssr: false });
