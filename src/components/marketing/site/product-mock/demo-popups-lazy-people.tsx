"use client";

/**
 * The Residents and Vendors pop-ups and record pages, loaded on demand (see `demo-popups-lazy.tsx`). None of them,
 * nor the real wizard steps they draw with, is in the home page's first load: each is a `next/dynamic` chunk and
 * `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";
import { DemoPopupLoading, DemoSampleLoading } from "./demo-sample-loading";

const people = () => import("@/components/marketing/site/product-mock/demo-popups-people");

export const DemoResidentWizardPopup = dynamic(() => people().then((m) => m.DemoResidentWizardPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoResidentRecord = dynamic(() => people().then((m) => m.DemoResidentRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoResidentActionPopup = dynamic(() => people().then((m) => m.DemoResidentActionPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoApproveResidentPopup = dynamic(() => people().then((m) => m.DemoApproveResidentPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoMessagePreviewPopup = dynamic(() => people().then((m) => m.DemoMessagePreviewPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoDialogPopup = dynamic(() => people().then((m) => m.DemoDialogPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorFormPopup = dynamic(() => people().then((m) => m.DemoVendorFormPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorRecord = dynamic(() => people().then((m) => m.DemoVendorRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoCatalogVendorRecord = dynamic(() => people().then((m) => m.DemoCatalogVendorRecord), { ssr: false, loading: DemoSampleLoading });
