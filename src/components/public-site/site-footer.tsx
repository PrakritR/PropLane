import Link from "next/link";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { SITE_PORTAL_HREF } from "@/components/public-site/journey-paths";

/** The approved homepage's footer, one hairline row: Blog · Privacy · Terms · App Store · Sign in. */
export function SiteFooter() {
  return (
    <footer className="ps ps-foot">
      <div className="ps-wrap ps-foot-in">
        <Link href="/rent/browse" data-attr="site-foot-browse">Find a home</Link>
        <Link href="/blog" prefetch={false}>Blog</Link>
        <Link href="/privacy" prefetch={false}>Privacy</Link>
        <Link href="/tos" prefetch={false}>Terms</Link>
        <a href={iosAppDownloadUrl()} data-attr="site-foot-app-store">App Store</a>
        <Link href={SITE_PORTAL_HREF} prefetch={false}>Sign in</Link>
        <span className="ps-foot-copy">© {new Date().getFullYear()} PropLane</span>
      </div>
    </footer>
  );
}
