"use client";

/**
 * The vendor tabs' pop-ups and record pages, loaded on demand. They only exist after a click, so none of them (nor the
 * real wizard and record pieces they draw with) is in the home page's first load: each is its own `next/dynamic`
 * chunk, `ssr: false`, the same way `demo-popups-lazy.tsx` does it for the manager Forms tab.
 */

import dynamic from "next/dynamic";
import { DemoPopupLoading, DemoSampleLoading } from "./demo-sample-loading";

const popups = () => import("@/components/marketing/site/product-mock/demo-popups-vendor");
const records = () => import("@/components/marketing/site/product-mock/demo-records-vendor");

export const DemoVendorComposeDialog = dynamic(() => popups().then((m) => m.DemoVendorComposeDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorQuoteWizard = dynamic(() => popups().then((m) => m.DemoVendorQuoteWizard), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorAvailabilityDialog = dynamic(() => popups().then((m) => m.DemoVendorAvailabilityDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorVisitDialog = dynamic(() => popups().then((m) => m.DemoVendorVisitDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorReplyDialog = dynamic(() => popups().then((m) => m.DemoVendorReplyDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorWithdrawDialog = dynamic(() => popups().then((m) => m.DemoVendorWithdrawDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorAddBankDialog = dynamic(() => popups().then((m) => m.DemoVendorAddBankDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorRefundDialog = dynamic(() => popups().then((m) => m.DemoVendorRefundDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorStatementDialog = dynamic(() => popups().then((m) => m.DemoVendorStatementDialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorW9Dialog = dynamic(() => popups().then((m) => m.DemoVendorW9Dialog), { ssr: false, loading: DemoPopupLoading });
export const DemoVendorUploadDocumentPopup = dynamic(() => popups().then((m) => m.DemoVendorUploadDocumentPopup), { ssr: false, loading: DemoPopupLoading });

export const DemoVendorJobRecord = dynamic(() => records().then((m) => m.DemoVendorJobRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoVendorInvoiceRecord = dynamic(() => records().then((m) => m.DemoVendorInvoiceRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoVendorPaymentRecord = dynamic(() => records().then((m) => m.DemoVendorPaymentRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoVendorWithdrawalRecord = dynamic(() => records().then((m) => m.DemoVendorWithdrawalRecord), { ssr: false, loading: DemoSampleLoading });
export const DemoVendorDocumentViewer = dynamic(() => records().then((m) => m.DemoVendorDocumentViewer), { ssr: false, loading: DemoSampleLoading });
