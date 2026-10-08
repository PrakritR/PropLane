"use client";

/**
 * The resident pop-ups and record pages of the home demo, loaded on demand. Nothing here exists before a click
 * (or a sub tab opened), so none of it, nor the real portal pieces it draws with, is in the home page's first load:
 * each is its own `next/dynamic` chunk, the same way `demo-popups-lazy.tsx` does it for the manager. `ssr: false`
 * because the page renders nothing of this on the server.
 */

import dynamic from "next/dynamic";

const resident = () => import("@/components/marketing/site/product-mock/demo-popups-resident");

export const DemoCustomizeDashboard = dynamic(() => resident().then((m) => m.DemoCustomizeDashboard), { ssr: false });

export const ResidentPlacementBody = dynamic(() => resident().then((m) => m.ResidentPlacementBody), { ssr: false });
export const ResidentMoveInDetailsBody = dynamic(() => resident().then((m) => m.ResidentMoveInDetailsBody), { ssr: false });
export const ResidentRoommatesBody = dynamic(() => resident().then((m) => m.ResidentRoommatesBody), { ssr: false });
export const ResidentInspectionRecord = dynamic(() => resident().then((m) => m.ResidentInspectionRecord), { ssr: false });

export const ResidentLeaseRecord = dynamic(() => resident().then((m) => m.ResidentLeaseRecord), { ssr: false });
export const ResidentFormFlow = dynamic(() => resident().then((m) => m.ResidentFormFlow), { ssr: false });

export const ResidentAddServiceModal = dynamic(() => resident().then((m) => m.ResidentAddServiceModal), { ssr: false });
export const ResidentServiceRecord = dynamic(() => resident().then((m) => m.ResidentServiceRecord), { ssr: false });
export const ResidentConfirmModal = dynamic(() => resident().then((m) => m.ResidentConfirmModal), { ssr: false });

export const ResidentScheduleTour = dynamic(() => resident().then((m) => m.ResidentScheduleTour), { ssr: false });
export const ResidentTourRecord = dynamic(() => resident().then((m) => m.ResidentTourRecord), { ssr: false });

export const ResidentApplyModal = dynamic(() => resident().then((m) => m.ResidentApplyModal), { ssr: false });
export const ResidentWithdrawModal = dynamic(() => resident().then((m) => m.ResidentWithdrawModal), { ssr: false });
export const ResidentApplicationRecord = dynamic(() => resident().then((m) => m.ResidentApplicationRecord), { ssr: false });

export const ResidentPayModal = dynamic(() => resident().then((m) => m.ResidentPayModal), { ssr: false });
export const ResidentPaymentRecord = dynamic(() => resident().then((m) => m.ResidentPaymentRecord), { ssr: false });

export const ResidentAddDocumentModal = dynamic(() => resident().then((m) => m.ResidentAddDocumentModal), { ssr: false });
export const ResidentReceiptRecord = dynamic(() => resident().then((m) => m.ResidentReceiptRecord), { ssr: false });

export const ResidentComposeModal = dynamic(() => resident().then((m) => m.ResidentComposeModal), { ssr: false });
