import Link from "next/link";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";

/**
 * Free-tier notice above the portal, linking to Billing in Settings.
 *
 * This component EXISTED but nothing rendered it — `buildProPortalDefinition`
 * had been returning `showPlanBanner` for a banner no layout mounted. So a
 * manager whose 14-day trial ran out silently lost residents, leases, inbox and
 * co-managers with nothing on screen to say why or where to pay (AXI-129).
 *
 * `lapsedFromTrial` is the difference between "you chose Free" and "your trial
 * ended" — the same screen, but only one of them is news.
 *
 * It is a subscription upsell, so the whole banner is hidden on native iOS
 * (Guideline 2.1(b)) via `.native-hide`; web is unchanged.
 */
export function ManagerPlanBanner({
  planHref = MANAGER_PLAN_PORTAL_URL,
  lapsedFromTrial = false,
}: {
  planHref?: string;
  lapsedFromTrial?: boolean;
}) {
  return (
    <div
      className="native-hide shrink-0 border-b border-amber-300 bg-[#fffbeb] px-[max(1rem,env(safe-area-inset-left,0px))] py-2.5 pe-[max(1rem,env(safe-area-inset-right,0px))] text-center text-xs leading-snug text-amber-950 sm:text-sm lg:px-8"
      data-attr="manager-plan-banner"
      data-lapsed={lapsedFromTrial ? "" : undefined}
    >
      <p className="font-medium">
        {lapsedFromTrial ? (
          <>Your free trial has ended, so you&apos;re on the <span className="font-semibold">Free</span> plan (1 property). </>
        ) : (
          <>You&apos;re on the <span className="font-semibold">Free</span> plan (1 property). </>
        )}
        <Link href={planHref} className="font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-950">
          Upgrade to Pro or Business
        </Link>{" "}
        for residents, leases, inbox, and co-managers.
      </p>
    </div>
  );
}
