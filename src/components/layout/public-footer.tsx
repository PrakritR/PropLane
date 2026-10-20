import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { FooterTextNumber } from "@/components/layout/footer-text-number";

/** A closing ink-blue band with the configured number and existing public links. */
export function PublicFooter({
  compact = false,
  texting,
}: {
  compact?: boolean;
  texting?: PublicTextingConfig | null;
}) {
  const phone = formatPublicPhone(texting?.phone);
  const links = [
    ["/blog", "Blog"],
    ["/privacy", "Privacy"],
    ["/tos", "Terms"],
    ["/security", "Security"],
    [iosAppDownloadUrl(), "App Store"],
    ["/auth/sign-in", "Portal"],
    ["/#contact", "Contact"],
  ];
  return (
    <footer
      data-site-footer
      data-home-footer
      className={`public-simple-footer ${compact ? "public-simple-footer-compact" : ""}`}
    >
      <svg className="public-footer-waves" viewBox="0 0 1440 360" preserveAspectRatio="none" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <path key={index} d={`M-80 ${index * 32 + 32} C240 ${index * 22 - 70}, 490 ${index * 28 + 150}, 820 ${index * 25 + 60} S1250 ${index * 28 - 20}, 1520 ${index * 32 + 90}`} />)}
      </svg>
      <div className="public-simple-footer-inner">
        <div className="public-simple-footer-grid">
          <div className="public-simple-footer-number">
            <Link
              href="/"
              className="public-simple-footer-logo"
              aria-label="PropLane home"
            >
              <ProPlaneMarkIcon />
              PropLane
            </Link>
            {phone && texting?.smsHref && <FooterTextNumber phone={phone} smsHref={texting.smsHref} />}
          </div>
          <nav aria-label="Footer navigation">
            {links.map(([href, label]) => (
              <Link
                key={label}
                href={href}
                prefetch={false}
                data-attr={
                  label === "App Store" ? "footer-app-store" : undefined
                }
              >
                {label}
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            ))}
          </nav>
        </div>
        <div className="public-simple-footer-legal">
          <span>© {new Date().getFullYear()} PropLane</span>
          <span>Seattle</span>
        </div>
      </div>
    </footer>
  );
}
