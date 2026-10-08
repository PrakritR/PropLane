"use client";

/**
 * The Residents and Vendors pop-ups and record pages, loaded on demand (see `demo-popups-lazy.tsx`). None of them,
 * nor the real wizard steps they draw with, is in the home page's first load: each is a `next/dynamic` chunk and
 * `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";

const people = () => import("@/components/marketing/site/product-mock/demo-popups-people");

export const DemoResidentWizardPopup = dynamic(() => people().then((m) => m.DemoResidentWizardPopup), { ssr: false });
export const DemoResidentRecord = dynamic(() => people().then((m) => m.DemoResidentRecord), { ssr: false });
export const DemoResidentActionPopup = dynamic(() => people().then((m) => m.DemoResidentActionPopup), { ssr: false });
export const DemoApproveResidentPopup = dynamic(() => people().then((m) => m.DemoApproveResidentPopup), { ssr: false });
export const DemoMessagePreviewPopup = dynamic(() => people().then((m) => m.DemoMessagePreviewPopup), { ssr: false });
export const DemoDialogPopup = dynamic(() => people().then((m) => m.DemoDialogPopup), { ssr: false });
export const DemoVendorFormPopup = dynamic(() => people().then((m) => m.DemoVendorFormPopup), { ssr: false });
export const DemoVendorRecord = dynamic(() => people().then((m) => m.DemoVendorRecord), { ssr: false });
export const DemoCatalogVendorRecord = dynamic(() => people().then((m) => m.DemoCatalogVendorRecord), { ssr: false });
