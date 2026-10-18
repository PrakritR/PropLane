import Link from "next/link";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { AxisLogoLink } from "@/components/brand/axis-logo";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { LegacyPublicFooter } from "@/components/layout/legacy-public-footer";
import { PublicFooterRoute } from "@/components/layout/public-footer-route";

function HomeFooter() {
  return (
    <footer data-site-footer data-home-footer className="[&_a]:min-w-11 border-t border-[#dce6f0] bg-[#f8fbff] px-6 pb-[calc(104px+env(safe-area-inset-bottom,0px))] pt-10 sm:px-10 sm:pb-10">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-6 sm:flex-row sm:flex-wrap sm:justify-between">
        <div className="[&>a]:min-h-11"><AxisLogoLink href="/" size="compact" /></div>
        <AppStoreBadge size="lg" dataAttr="footer-app-store" />
        <nav aria-label="Footer navigation" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-sm text-[#334b65]">
          <Link href="/auth/sign-in" prefetch={false} className="inline-flex min-h-12 items-center hover:text-primary">Sign in</Link>
          <Link href="/privacy" prefetch={false} className="inline-flex min-h-12 items-center hover:text-primary">Privacy</Link>
          <Link href="/tos" prefetch={false} className="inline-flex min-h-12 items-center hover:text-primary">Terms</Link>
          <Link href="/sms-terms" prefetch={false} className="inline-flex min-h-12 items-center hover:text-primary">SMS terms</Link>
        </nav>
      </div>
      <p className="mx-auto mt-6 max-w-[1200px] text-center text-xs text-[#52677e] sm:text-left">© 2026 PropLane</p>
    </footer>
  );
}

export function PublicFooter({ compact = false, texting = null }: { compact?: boolean; texting?: PublicTextingConfig | null }) {
  if (compact) return <LegacyPublicFooter compact texting={texting} />;
  return <PublicFooterRoute home={<HomeFooter />}><LegacyPublicFooter texting={texting} /></PublicFooterRoute>;
}
