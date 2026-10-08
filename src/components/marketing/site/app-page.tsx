import Image from "next/image";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { SITE_MEASURE, SiteEyebrow, SitePageHero } from "@/components/marketing/site/primitives";
import { IOS_APP_MINIMUM_OS, iosAppDownloadIsTestFlight, iosAppDownloadUrl } from "@/lib/ios-app-download";
import dashboardShot from "../../../../app-store/screenshots/iphone-6.9/02-dashboard.png";
import paymentsShot from "../../../../app-store/screenshots/iphone-6.9/05-payments.png";
import inspectionsShot from "../../../../app-store/screenshots/iphone-6.9/08-inspections.png";
import inboxShot from "../../../../app-store/screenshots/iphone-6.9/09-inbox.png";

/**
 * /app — the iPhone app page. Headline, the App Store badge, a requirements
 * line, the phones side by side, and four feature rows. Nothing here reads live
 * data.
 *
 * The phones are the committed App Store screenshots (`app-store/screenshots/
 * iphone-6.9`), imported through the ONE manifest below. The App Store
 * screenshot pipeline (`npm run app-store:shots`, see `app-store/README.md`)
 * rewrites those files from the live portal, so a portal redesign plus a
 * re-shoot updates this page with no edit here. To show a different screen, change the
 * manifest, not the markup. See docs/agents/marketing-mocks.md.
 */
const APP_PAGE_SHOTS = [
  { src: dashboardShot, alt: "The PropLane dashboard on iPhone: occupancy, rent collected and what needs you today" },
  { src: paymentsShot, alt: "Payments on iPhone: rent collected per room and every charge tracked" },
  { src: inspectionsShot, alt: "Move-in inspections on iPhone: photos per room" },
  { src: inboxShot, alt: "The inbox on iPhone: residents, applicants and the PropLane assistant in one place" },
] as const;

const FEATURES = [
  { title: "Push when it matters", body: "A lease to countersign, a change order, a tour that moved — one tap, from wherever you are." },
  { title: "Camera for inspections", body: "Room-by-room photos straight into the move-in / move-out report, with the room already picked." },
  { title: "Work number, on the go", body: "Texts and calls under your PropLane number, not your cell — the same thread as the web inbox." },
  { title: "Three portals, one app", body: "Manager, resident and vendor sign-ins all live here. Same account as the web." },
];

export function SiteAppPage() {
  const url = iosAppDownloadUrl();
  const beta = iosAppDownloadIsTestFlight(url);

  return (
    <>
      <SitePageHero
        eyebrow={beta ? "iPhone app · beta" : "iPhone app · free"}
        title="The same queue, in your pocket."
        actions={<AppStoreBadge size="lg" dataAttr="app-page-app-store" />}
        note={
          <span className="flex flex-wrap justify-center gap-x-2">
            <span>iOS {IOS_APP_MINIMUM_OS} or later</span>
            <span aria-hidden>·</span>
            <span>Same account as the web</span>
            <span aria-hidden>·</span>
            <span>Free</span>
          </span>
        }
      />
      <div className={`${SITE_MEASURE} pb-20 sm:pb-24`}>
        {/* Equal phones in one row: two by two on a phone, four across from md. Same box, same aspect, same alignment. */}
        <ul className="mx-auto grid max-w-[1100px] grid-cols-2 gap-3 sm:gap-5 md:grid-cols-4 lg:gap-7">
          {APP_PAGE_SHOTS.map((shot) => (
            <li key={shot.alt} className="min-w-0">
              <Image
                src={shot.src}
                alt={shot.alt}
                sizes="(min-width: 1100px) 260px, (min-width: 768px) 24vw, 46vw"
                className="block h-auto w-full rounded-[22px] border border-[#cfdceb] bg-white shadow-[0_24px_60px_-30px_rgba(19,43,71,0.35)] sm:rounded-[28px]"
              />
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-16 max-w-[1100px] sm:mt-20">
          <SiteEyebrow className="mb-4 text-center">In the app</SiteEyebrow>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-2xl border border-[#dbe4ef] bg-white/85 p-5 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]">
                <h2 className="text-[15px] font-bold text-foreground">{f.title}</h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
