import type { Metadata } from "next";
import { VendorQuotePublicPage } from "./vendor-quote-public-page";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Service bid",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: "no-referrer",
};

export default function VendorQuotePage() {
  return <VendorQuotePublicPage />;
}
