"use client";

/**
 * The resident pop-ups and record pages of the home demo, loaded on demand. Nothing here exists before a click
 * (or a sub tab opened), so none of it, nor the real portal pieces it draws with, is in the home page's first load:
 * each is its own `next/dynamic` chunk, the same way `demo-popups-lazy.tsx` does it for the manager. `ssr: false`
 * because the page renders nothing of this on the server.
 */

import dynamic from "next/dynamic";
import { DemoPopupLoading, DemoSampleLoading } from "./demo-sample-loading";

const resident = () => import("@/components/marketing/site/product-mock/demo-popups-resident");

export const DemoCustomizeDashboard = dynamic(() => resident().then((m) => m.DemoCustomizeDashboard), { ssr: false, loading: DemoPopupLoading });

export const ResidentPlacementBody = dynamic(() => resident().then((m) => m.ResidentPlacementBody), { ssr: false, loading: DemoSampleLoading });
export const ResidentMoveInDetailsBody = dynamic(() => resident().then((m) => m.ResidentMoveInDetailsBody), { ssr: false, loading: DemoSampleLoading });
export const ResidentRoommatesBody = dynamic(() => resident().then((m) => m.ResidentRoommatesBody), { ssr: false, loading: DemoSampleLoading });
export const ResidentInspectionRecord = dynamic(() => resident().then((m) => m.ResidentInspectionRecord), { ssr: false, loading: DemoSampleLoading });

export const ResidentLeaseRecord = dynamic(() => resident().then((m) => m.ResidentLeaseRecord), { ssr: false, loading: DemoSampleLoading });
export const ResidentFormFlow = dynamic(() => resident().then((m) => m.ResidentFormFlow), { ssr: false, loading: DemoSampleLoading });

export const ResidentAddServiceModal = dynamic(() => resident().then((m) => m.ResidentAddServiceModal), { ssr: false, loading: DemoPopupLoading });
export const ResidentServiceRecord = dynamic(() => resident().then((m) => m.ResidentServiceRecord), { ssr: false, loading: DemoSampleLoading });
export const ResidentConfirmModal = dynamic(() => resident().then((m) => m.ResidentConfirmModal), { ssr: false, loading: DemoPopupLoading });

export const ResidentScheduleTour = dynamic(() => resident().then((m) => m.ResidentScheduleTour), { ssr: false, loading: DemoPopupLoading });
export const ResidentTourRecord = dynamic(() => resident().then((m) => m.ResidentTourRecord), { ssr: false, loading: DemoSampleLoading });

export const ResidentApplyModal = dynamic(() => resident().then((m) => m.ResidentApplyModal), { ssr: false, loading: DemoPopupLoading });
export const ResidentWithdrawModal = dynamic(() => resident().then((m) => m.ResidentWithdrawModal), { ssr: false, loading: DemoPopupLoading });
export const ResidentApplicationRecord = dynamic(() => resident().then((m) => m.ResidentApplicationRecord), { ssr: false, loading: DemoSampleLoading });

export const ResidentPayModal = dynamic(() => resident().then((m) => m.ResidentPayModal), { ssr: false, loading: DemoPopupLoading });
export const ResidentPaymentRecord = dynamic(() => resident().then((m) => m.ResidentPaymentRecord), { ssr: false, loading: DemoSampleLoading });

export const ResidentAddDocumentModal = dynamic(() => resident().then((m) => m.ResidentAddDocumentModal), { ssr: false, loading: DemoPopupLoading });
export const ResidentReceiptRecord = dynamic(() => resident().then((m) => m.ResidentReceiptRecord), { ssr: false, loading: DemoSampleLoading });

export const ResidentComposeModal = dynamic(() => resident().then((m) => m.ResidentComposeModal), { ssr: false, loading: DemoPopupLoading });
