"use client";

/**
 * The operations tabs' pop-ups and record pages (Tasks, Bookings, Promotion, Outgoing payments, Finances, Documents),
 * loaded on demand. A pop-up only exists after a click, so none of them (nor the real wizard pieces they draw with) is
 * in the home page's first load: each is its own `next/dynamic` chunk, the same way `demo-popups-lazy.tsx` does it.
 * `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";
import { DemoPopupLoading, DemoSampleLoading } from "./demo-sample-loading";

const ops = () => import("@/components/marketing/site/product-mock/demo-popups-ops");

export const DemoTaskFormPopup = dynamic(() => ops().then((m) => m.DemoTaskFormPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoTaskRecord = dynamic(() => ops().then((m) => m.DemoTaskRecord), { ssr: false, loading: DemoSampleLoading });

export const DemoBookingPopup = dynamic(() => ops().then((m) => m.DemoBookingPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoBookingDayDialog = dynamic(() => ops().then((m) => m.DemoBookingDayDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoBookingRecord = dynamic(() => ops().then((m) => m.DemoBookingRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoConfirmDialog = dynamic(() => ops().then((m) => m.DemoConfirmDialog), { ssr: false, loading: DemoPopupLoading });

export const DemoPromotionNewPopup = dynamic(() => ops().then((m) => m.DemoPromotionNewPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoPromotionViewDialog = dynamic(() => ops().then((m) => m.DemoPromotionViewDialog), { ssr: false, loading: DemoPopupLoading });

export const DemoOutgoingAddPopup = dynamic(() => ops().then((m) => m.DemoOutgoingAddPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoOutgoingDialog = dynamic(() => ops().then((m) => m.DemoOutgoingDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoOutgoingRecord = dynamic(() => ops().then((m) => m.DemoOutgoingRecord), { ssr: false, loading: DemoSampleLoading });

export const DemoFinancialEntryDialog = dynamic(() => ops().then((m) => m.DemoFinancialEntryDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoExpensePopup = dynamic(() => ops().then((m) => m.DemoExpensePopup), { ssr: false, loading: DemoPopupLoading });
export const DemoIncomePopup = dynamic(() => ops().then((m) => m.DemoIncomePopup), { ssr: false, loading: DemoPopupLoading });
export const DemoReportPage = dynamic(() => ops().then((m) => m.DemoReportPage), { ssr: false, loading: DemoSampleLoading });

export const DemoUploadDocumentPopup = dynamic(() => ops().then((m) => m.DemoUploadDocumentPopup), { ssr: false, loading: DemoPopupLoading });
export const DemoDocumentPreviewDialog = dynamic(() => ops().then((m) => m.DemoDocumentPreviewDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoLeaseInlinePreview = dynamic(() => ops().then((m) => m.DemoLeaseInlinePreview), { ssr: false, loading: DemoSampleLoading });
export const DemoApplicationDocRecord = dynamic(() => ops().then((m) => m.DemoApplicationDocRecord), { ssr: false, loading: DemoSampleLoading });
