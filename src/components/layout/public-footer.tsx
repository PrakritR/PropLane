import Link from "next/link";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { AxisLogoLink } from "@/components/brand/axis-logo";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";

const LINKS = [["/blog", "Blog"], ["/privacy", "Privacy"], ["/tos", "Terms"], ["/auth/sign-in", "Sign in"]];

/** Compact on every public route; legacy callers may still pass their optional config. */
export function PublicFooter({ compact = false }: { compact?: boolean; texting?: PublicTextingConfig | null }) {
  return <footer data-site-footer data-home-footer className={`public-simple-footer ${compact ? "public-simple-footer-compact" : ""}`}>
    <div className="public-simple-footer-inner">
      <AxisLogoLink href="/" size="compact" />
      <nav aria-label="Footer navigation">{LINKS.map(([href, label]) => <Link key={href} href={href} prefetch={false}>{label}</Link>)}</nav>
      <AppStoreBadge size="lg" dataAttr="footer-app-store" />
    </div>
  </footer>;
}
