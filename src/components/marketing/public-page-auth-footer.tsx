import Link from "next/link";
import { BOOK_DEMO_HREF } from "@/lib/marketing/public-contact";
import "@/components/marketing/landing-proplane.css";

type PublicPageAuthFooterProps = {
  getStartedHref: string;
  signInHref: string;
  getStartedLabel?: string;
  getStartedDataAttr?: string;
  signInDataAttr?: string;
  /** Optional secondary CTA (defaults to Book a demo → the homepage Contact form). */
  secondaryHref?: string;
  secondaryLabel?: string;
  secondaryDataAttr?: string;
  showSecondary?: boolean;
};

/** Shared bottom CTA — Get started + Book a demo, plus Sign in. */
export function PublicPageAuthFooter({
  getStartedHref,
  signInHref,
  getStartedLabel = "Get started",
  getStartedDataAttr = "public-get-started",
  signInDataAttr = "public-sign-in",
  secondaryHref = BOOK_DEMO_HREF,
  secondaryLabel = "Book a demo",
  secondaryDataAttr = "public-book-demo",
  showSecondary = true,
}: PublicPageAuthFooterProps) {
  return (
    <div className="lp-root lp-auth-footer mx-auto max-w-md space-y-4 pb-6 text-center sm:pb-8">
      <div className="lp-cta-row flex flex-col gap-2.5 sm:flex-row sm:justify-center">
        <Link
          href={getStartedHref}
          data-attr={getStartedDataAttr}
          className="lp-btn lp-btn-blue lp-lg w-full sm:w-auto"
        >
          {getStartedLabel}
        </Link>
        {showSecondary ? (
          <Link
            href={secondaryHref}
            data-attr={secondaryDataAttr}
            className="lp-btn lp-btn-ghost lp-lg w-full sm:w-auto"
          >
            {secondaryLabel}
          </Link>
        ) : null}
      </div>
      <p className="text-sm text-[var(--pl-muted-fg)]">
        Already have an account?{" "}
        <Link
          href={signInHref}
          data-attr={signInDataAttr}
          className="font-semibold text-[var(--pl-brand)] hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
