import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { formatPublicPhone } from "@/lib/marketing/format-public-phone";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";

/** The approved Swiss footer uses the same public line as the cover. */
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
    [iosAppDownloadUrl(), "App Store"],
    ["/auth/sign-in", "Sign in"],
    ["/#contact", "Contact"],
  ];
  return (
    <footer
      data-site-footer
      data-home-footer
      className={`public-simple-footer ${compact ? "public-simple-footer-compact" : ""}`}
    >
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
            {phone && texting?.smsHref && (
              <a
                href={texting.smsHref}
                aria-label={`Text ${phone}`}
                data-attr="footer-text"
              >
                {phone}
              </a>
            )}
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
          <span>PropLane</span>
          <span>Seattle</span>
        </div>
      </div>
    </footer>
  );
}
