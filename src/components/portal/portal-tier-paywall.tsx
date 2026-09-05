import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";

const primaryCta =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition-[filter] hover:brightness-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function LockedFeaturePreview() {
  return (
    <div
      className="min-h-[28rem] overflow-hidden rounded-2xl border border-border bg-card"
      aria-hidden="true"
      inert
      data-paywall-preview
    >
      <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="space-y-2">
          <div className="h-4 w-32 rounded bg-accent" />
          <div className="h-3 w-48 max-w-[55vw] rounded bg-accent/70" />
        </div>
        <div className="h-10 w-28 rounded-lg bg-accent" />
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="h-8 w-20 rounded-full bg-accent" />
        <div className="h-8 w-24 rounded-full bg-accent/70" />
        <div className="h-8 w-20 rounded-full bg-accent/70" />
      </div>
      <div className="divide-y divide-border px-4 sm:px-6">
        {["one", "two", "three", "four"].map((row) => (
          <div key={row} className="flex min-h-20 items-center gap-4 py-4">
            <div className="h-10 w-10 shrink-0 rounded-xl bg-accent" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-2/5 rounded bg-accent" />
              <div className="h-3 w-3/5 rounded bg-accent/70" />
            </div>
            <div className="h-6 w-16 rounded-full bg-accent/70" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LockedFeatureCard({
  featureLabel,
  audience,
  basePath,
}: {
  featureLabel: string;
  audience: "manager" | "resident";
  basePath: string;
}) {
  const manager = audience === "manager";
  return (
    <div
      className="w-full max-w-md rounded-2xl border border-border bg-background p-6 text-center sm:p-8"
      role="region"
      aria-label={`${featureLabel} access required`}
    >
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-accent text-primary">
        <LockKeyhole className="h-5 w-5" aria-hidden="true" />
      </div>
      <h2 className="mt-4 text-xl font-semibold tracking-[-0.02em] text-foreground">
        {manager ? (
          <>
            <span className="native-hide">Unlock {featureLabel}</span>
            <span className="native-only">Access {featureLabel}</span>
          </>
        ) : (
          <>Access {featureLabel}</>
        )}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
        {manager ? (
          <>
            <span className="native-hide">
              {featureLabel} is available on Pro and Business plans. Your data stays in place and appears here after
              you upgrade.
            </span>
            <span className="native-only">This feature isn&apos;t included on your current plan.</span>
          </>
        ) : (
          <>{featureLabel} is not included in your property manager&apos;s current plan. Ask them to upgrade the workspace to restore access.</>
        )}
      </p>

      {manager ? (
        <>
          <div className="native-hide mt-5">
            <Link
              href={MANAGER_PLAN_PORTAL_URL}
              className={primaryCta}
              data-attr="manager-tier-paywall-upgrade"
            >
              Upgrade to Pro or Business
            </Link>
          </div>
          <div className="native-only mt-5">
            <Link href={MANAGER_PLAN_PORTAL_URL} className={primaryCta} data-attr="manager-tier-paywall-view-plans">
              View plans
            </Link>
          </div>
        </>
      ) : (
        <Link
          href={`${basePath}/communication/active`}
          className={`${primaryCta} mt-5`}
          data-attr="resident-tier-paywall-contact-manager"
        >
          Message property manager
        </Link>
      )}

      <p className="mt-4 text-xs text-muted">
        <Link
          href={`${basePath}/dashboard`}
          className="inline-flex min-h-10 items-center font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}

/** Shown when a property portal user on the Free plan opens a paid section. */
export function PortalTierPaywall({
  basePath,
  featureLabel,
}: {
  basePath: string;
  featureLabel?: string;
}) {
  const label = featureLabel ?? "this feature";

  return (
    <ManagerPortalPageShell title={featureLabel ?? "Locked feature"}>
      <div className="relative" data-tier-paywall>
        <div className="pointer-events-none select-none opacity-35 grayscale" data-tier-paywall-disabled-content>
          <LockedFeaturePreview />
        </div>
        <div className="absolute inset-0 flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm sm:p-6">
          <LockedFeatureCard featureLabel={label} audience="manager" basePath={basePath} />
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}

/** Resident-facing version for features controlled by the property manager's plan. */
export function ResidentTierPaywall({
  basePath = "/resident",
  featureLabel,
}: {
  basePath?: string;
  featureLabel: string;
}) {
  return (
    <ManagerPortalPageShell title={featureLabel} hideTitleOnMobileNav>
      <div className="relative" data-tier-paywall>
        <div className="pointer-events-none select-none opacity-35 grayscale" data-tier-paywall-disabled-content>
          <LockedFeaturePreview />
        </div>
        <div className="absolute inset-0 flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm sm:p-6">
          <LockedFeatureCard featureLabel={featureLabel} audience="resident" basePath={basePath} />
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
