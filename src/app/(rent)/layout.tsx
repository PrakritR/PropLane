import { PublicShell } from "@/components/layout/public-shell";
import "@/components/public-site/public-site.css";
import type { Metadata } from "next";
import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";
// The same first-flush styles as the (public) layout: /rent is the same public site, minus the texting number.
import "@/components/marketing/texting-home.css";
import "@/components/marketing/home-scroll-stage.css";
import "@/components/marketing/home-number-hero.css";
import "@/components/marketing/resident-lifecycle-phone.css";
import "@/components/marketing/resident-lifecycle-atmosphere.css";
import "@/components/marketing/site/pricing-cards.css";
import "@/components/marketing/home-swiss.css";
import "@/components/marketing/home-viewport.css";
import "@/components/marketing/home-iphone-phone.css";
import "@/components/marketing/home-software-demo.css";
import "@/components/marketing/public-footer-band.css";

export const metadata: Metadata = {
  itunes: {
    appId: IOS_APP_STORE_APP_ID,
    appArgument: "https://prop-lane.space/app",
  },
};

/**
 * `/rent/*` is the WEB channel (captain, Oct 20): a request made on the website is answered on the website, so this
 * layout never reads the PropLane number. It is the (public) shell with no texting snapshot, which keeps the number
 * and the sms href out of every /rent payload (the footer's `isRentPath` guard only hid them in the browser).
 */
export default function RentLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell texting={{ phone: null, smsHref: null }}>{children}</PublicShell>;
}
