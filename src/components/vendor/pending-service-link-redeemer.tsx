"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { redeemServiceLink } from "@/lib/service-work-share-client";
import {
  PENDING_SERVICE_LINK_COOKIE,
  parseVendorJobChoice,
  vendorJobChoiceHref,
} from "@/lib/vendor-job-choice";

function readPendingLink(): { token: string; choice: ReturnType<typeof parseVendorJobChoice> } | null {
  try {
    const entry = document.cookie.split("; ").find((part) => part.startsWith(`${PENDING_SERVICE_LINK_COOKIE}=`));
    if (!entry) return null;
    const parsed = JSON.parse(decodeURIComponent(entry.slice(PENDING_SERVICE_LINK_COOKIE.length + 1))) as { token?: unknown; choice?: unknown };
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    return token ? { token, choice: parseVendorJobChoice(typeof parsed.choice === "string" ? parsed.choice : null) } : null;
  } catch {
    return null;
  }
}

function clearPendingLink() {
  document.cookie = `${PENDING_SERVICE_LINK_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

/**
 * Finishes a texted service link once the vendor is signed in (vendor-work-share-1006). The public
 * page parks the link in a cookie before sending the visitor to sign up or sign in (email or
 * Google); the vendor portal mounts this once and redeems it: the roster row and the `sent` offer
 * are made server-side, then the vendor lands on the job (or stays on onboarding with a toast).
 */
export function PendingServiceLinkRedeemer() {
  const router = useRouter();
  const pathname = usePathname();
  const { showToast } = useAppUi();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    const pending = readPendingLink();
    if (!pending) return;
    ran.current = true;
    void (async () => {
      const choice = pending.choice ?? "bid";
      const result = await redeemServiceLink(pending.token, choice);
      if (result.ok) {
        clearPendingLink();
        if (pathname?.startsWith("/vendor/onboarding")) {
          showToast("The job is waiting in your Services.");
        } else {
          router.push(vendorJobChoiceHref("/vendor", result.workOrderId, choice));
        }
        return;
      }
      // 401 / 429: the vendor is not signed in yet or is throttled - keep the link for next time.
      if (result.status === 401 || result.status === 429 || result.status === 0) {
        ran.current = false;
        return;
      }
      clearPendingLink();
      showToast(result.error);
    })();
  }, [pathname, router, showToast]);

  return null;
}
