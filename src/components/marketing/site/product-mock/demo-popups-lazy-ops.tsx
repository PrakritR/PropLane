"use client";

/**
 * The operations tabs' pop-ups and record pages (Tasks, Bookings, Promotion, Outgoing payments, Finances, Documents),
 * loaded on demand. A pop-up only exists after a click, so none of them (nor the real wizard pieces they draw with) is
 * in the home page's first load: each is its own `next/dynamic` chunk, the same way `demo-popups-lazy.tsx` does it.
 * `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";

const ops = () => import("@/components/marketing/site/product-mock/demo-popups-ops");

export const DemoTaskFormPopup = dynamic(() => ops().then((m) => m.DemoTaskFormPopup), { ssr: false });
export const DemoTaskRecord = dynamic(() => ops().then((m) => m.DemoTaskRecord), { ssr: false });

export const DemoBookingPopup = dynamic(() => ops().then((m) => m.DemoBookingPopup), { ssr: false });
export const DemoBookingDayDialog = dynamic(() => ops().then((m) => m.DemoBookingDayDialog), { ssr: false });
export const DemoBookingRecord = dynamic(() => ops().then((m) => m.DemoBookingRecord), { ssr: false });
export const DemoConfirmDialog = dynamic(() => ops().then((m) => m.DemoConfirmDialog), { ssr: false });

export const DemoPromotionNewPopup = dynamic(() => ops().then((m) => m.DemoPromotionNewPopup), { ssr: false });
export const DemoPromotionViewDialog = dynamic(() => ops().then((m) => m.DemoPromotionViewDialog), { ssr: false });

export const DemoOutgoingAddPopup = dynamic(() => ops().then((m) => m.DemoOutgoingAddPopup), { ssr: false });
export const DemoOutgoingDialog = dynamic(() => ops().then((m) => m.DemoOutgoingDialog), { ssr: false });
export const DemoOutgoingRecord = dynamic(() => ops().then((m) => m.DemoOutgoingRecord), { ssr: false });

export const DemoFinancialEntryDialog = dynamic(() => ops().then((m) => m.DemoFinancialEntryDialog), { ssr: false });
export const DemoExpensePopup = dynamic(() => ops().then((m) => m.DemoExpensePopup), { ssr: false });
export const DemoIncomePopup = dynamic(() => ops().then((m) => m.DemoIncomePopup), { ssr: false });
export const DemoReportPage = dynamic(() => ops().then((m) => m.DemoReportPage), { ssr: false });

export const DemoUploadDocumentPopup = dynamic(() => ops().then((m) => m.DemoUploadDocumentPopup), { ssr: false });
export const DemoDocumentPreviewDialog = dynamic(() => ops().then((m) => m.DemoDocumentPreviewDialog), { ssr: false });
export const DemoLeaseInlinePreview = dynamic(() => ops().then((m) => m.DemoLeaseInlinePreview), { ssr: false });
export const DemoApplicationDocRecord = dynamic(() => ops().then((m) => m.DemoApplicationDocRecord), { ssr: false });
