import Image from "next/image";
import QRCode from "qrcode";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { SITE_MEASURE, SiteEyebrow, SiteHeading } from "@/components/marketing/site/primitives";
import { IOS_APP_MINIMUM_OS, iosAppDownloadIsTestFlight, iosAppDownloadUrl } from "@/lib/ios-app-download";
import "@/components/marketing/site/site.css";

/**
 * /app — the iPhone app page. Headline, the App Store badge, a requirements
 * line, two phone frames with clean screenshots of the shipped build, a QR code
 * for laptop visitors (rendered at build time from the same canonical URL the
 * badge uses), and four feature rows. Nothing here reads live data.
 */

const FEATURES = [
  { title: "Push for approvals", body: "A drafted reply, a lease to countersign, a late-rent reminder — one tap to approve, from wherever you are." },
  { title: "Camera for inspections", body: "Room-by-room photos straight into the move-in / move-out report, with the room already picked." },
  { title: "Work number, on the go", body: "Texts and calls under your PropLane number, not your cell — the same thread as the web inbox." },
  { title: "Three portals, one app", body: "Manager, resident and vendor sign-ins all live here. Same account as the web." },
];

export async function SiteAppPage() {
  const url = iosAppDownloadUrl();
  const beta = iosAppDownloadIsTestFlight(url);
  const qr = await QRCode.toString(url, { type: "svg", margin: 0, color: { dark: "#0b1120", light: "#ffffff00" } });

  return (
    <div className={`${SITE_MEASURE} pb-20 pt-12 sm:pt-16`}>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-14">
        <div className="min-w-0">
          <SiteEyebrow className="mb-4">{beta ? "iPhone app · beta" : "iPhone app · free"}</SiteEyebrow>
          <SiteHeading as="h1">The same queue, in your pocket.</SiteHeading>
          <p className="mt-5 max-w-[46ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            Approve applications, sign leases, answer residents and photograph an inspection — from the phone, with push for
            anything that needs your OK.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <AppStoreBadge size="lg" dataAttr="app-page-app-store" />
          </div>
          <p className="mt-4 flex flex-wrap gap-x-2 text-[13px] text-muted">
            <span>iOS {IOS_APP_MINIMUM_OS} or later</span>
            <span aria-hidden>·</span>
            <span>Same account as the web</span>
            <span aria-hidden>·</span>
            <span>Free</span>
          </p>

          <div className="mt-8 flex items-center gap-4 rounded-2xl border border-border bg-card p-4 sm:max-w-[440px]">
            <div
              className="h-[84px] w-[84px] shrink-0 rounded-lg bg-white p-1.5 [&>svg]:h-full [&>svg]:w-full"
              aria-label={`QR code that opens ${url}`}
              role="img"
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <p className="text-[13px] leading-relaxed text-muted">
              <span className="font-bold text-foreground">On a laptop?</span>
              <br />
              Point your phone&rsquo;s camera here to open the App Store listing.
            </p>
          </div>
        </div>

        <div className="site-app-shots" aria-hidden>
          <div className="site-app-phone">
            <Image src="/marketing/product/phone-dashboard.webp" alt="" width={390} height={844} sizes="220px" className="block h-auto w-full" />
          </div>
          <div className="site-app-phone is-back">
            <Image src="/marketing/product/phone-inbox.webp" alt="" width={390} height={844} sizes="200px" className="block h-auto w-full" />
          </div>
        </div>
      </div>

      <ul className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <li key={f.title} className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-[15px] font-bold text-foreground">{f.title}</h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
