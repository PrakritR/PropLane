"use client";

/**
 * The Payments, Services and Communication pop-ups and record pages, loaded on demand (the pattern of
 * `demo-popups-lazy.tsx`): none of them, nor the real wizard pieces they draw with, is in the home page's first
 * load. `ssr: false` because nothing here renders before a click.
 */

import dynamic from "next/dynamic";

const money = () => import("@/components/marketing/site/product-mock/demo-popups-money");

export const DemoAddChargePopup = dynamic(() => money().then((m) => m.DemoAddChargePopup), { ssr: false });
export const DemoEditPaymentPopup = dynamic(() => money().then((m) => m.DemoEditPaymentPopup), { ssr: false });
export const DemoPaymentRecordView = dynamic(() => money().then((m) => m.DemoPaymentRecordView), { ssr: false });
export const DemoAddServicePopup = dynamic(() => money().then((m) => m.DemoAddServicePopup), { ssr: false });
export const DemoServiceRecordView = dynamic(() => money().then((m) => m.DemoServiceRecordView), { ssr: false });
export const DemoNewMessagePopup = dynamic(() => money().then((m) => m.DemoNewMessagePopup), { ssr: false });

/** Starts the chunk early (a panel calls it once it is mounted) so a row click does not wait for the network. */
export function preloadMoneyPopups(): void {
  void money();
}
