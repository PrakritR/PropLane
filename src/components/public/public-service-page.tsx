"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { PublicServiceView } from "@/lib/public-service-projection";
import { fetchPublicService, redeemServiceLink } from "@/lib/service-work-share-client";
import {
  PENDING_SERVICE_LINK_COOKIE,
  VENDOR_JOB_CHOICES,
  vendorJobChoiceHref,
  type VendorJobChoiceId,
} from "@/lib/vendor-job-choice";

/** Bid now leads, as in the Find work row's menu. */
const PUBLIC_CHOICE_ORDER: readonly VendorJobChoiceId[] = ["bid", "estimate", "message"];

/** The cookie carries the link through sign-up / sign-in (email or Google); the vendor portal redeems it. */
function rememberPendingLink(token: string, choice: VendorJobChoiceId) {
  try {
    const value = encodeURIComponent(JSON.stringify({ token, choice }));
    document.cookie = `${PENDING_SERVICE_LINK_COOKIE}=${value}; path=/; max-age=${14 * 24 * 60 * 60}; SameSite=Lax`;
  } catch {
    /* cookies blocked: the vendor can open the link again once signed in */
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </>
  );
}

/**
 * The public page behind a texted service link (vendor-work-share-1006). It renders ONLY the
 * `publicServiceProjection` allowlist the API returns - there is no address, unit or resident to
 * show. Choosing an option redeems the link when a vendor is signed in; otherwise it remembers the
 * link and sends the visitor to create an account (or sign in), and the vendor portal finishes it.
 */
export function PublicServicePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const router = useRouter();
  const [service, setService] = useState<PublicServiceView | null>(null);
  const [state, setState] = useState<"open" | "closed">("open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<VendorJobChoiceId | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchPublicService(token).then((result) => {
      if (cancelled) return;
      if (!result.ok) setError(result.error);
      else {
        setService(result.service);
        setState(result.state);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const choose = async (choice: VendorJobChoiceId) => {
    setNotice("");
    setBusy(choice);
    const result = await redeemServiceLink(token, choice);
    setBusy(null);
    if (result.ok) {
      router.push(vendorJobChoiceHref("/vendor", result.workOrderId, choice));
      return;
    }
    if (result.status === 401) {
      rememberPendingLink(token, choice);
      router.push("/auth/create-account?mode=create&role=vendor");
      return;
    }
    if (result.status === 403) {
      setNotice("Sign in with a vendor account to continue.");
      return;
    }
    setNotice(result.error);
  };

  const signIn = () => {
    rememberPendingLink(token, "bid");
    router.push("/auth/sign-in");
  };

  if (error) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center" data-attr="public-service-unavailable">
        <h1 className="text-xl font-semibold text-foreground">Link unavailable</h1>
        <p className="mt-2 text-sm text-muted">{error}</p>
      </div>
    );
  }
  if (!service) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const place = [service.trade, service.area].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto w-full max-w-[640px] px-4 py-10 sm:px-0" data-attr="public-service-page">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4" data-attr="public-service-header">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-attr="public-service-title">
              {service.title}
            </h1>
            <p className="mt-1 text-sm text-muted">{place}</p>
          </div>
          {state === "closed" ? (
            <p className="text-sm font-medium text-foreground" data-attr="public-service-filled">
              This job has been filled.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" data-attr="public-service-actions">
              {PUBLIC_CHOICE_ORDER.map((id) => VENDOR_JOB_CHOICES.find((c) => c.id === id)!).map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant={option.id === "bid" ? "primary" : "outline"}
                  className="rounded-full px-4 py-2 text-sm"
                  disabled={busy !== null}
                  data-attr={`public-service-${option.id}`}
                  onClick={() => choose(option.id)}
                >
                  {option.label}
                </Button>
              ))}
              <Button type="button" variant="ghost" className="rounded-full px-4 py-2 text-sm" data-attr="public-service-sign-in" onClick={signIn}>
                I have an account
              </Button>
            </div>
          )}
          {notice ? (
            <p className="text-sm text-danger" role="alert" data-attr="public-service-notice">
              {notice}
            </p>
          ) : null}
        </div>
        {service.description ? <p className="mt-5 text-[15px] leading-relaxed text-foreground">{service.description}</p> : null}
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <Fact label="When" value={service.when} />
          <Fact label="Budget" value={service.budget} />
          <Fact label="Posted by" value={service.postedBy} />
        </dl>
        {service.photos.length > 0 ? (
          <div className="mt-4 grid grid-cols-2 gap-2" data-attr="public-service-photos">
            {service.photos.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={index} src={src} alt={`Photo ${index + 1}`} className="h-28 w-full rounded-xl border border-border object-cover" />
            ))}
          </div>
        ) : null}
        <p className="mt-5 text-xs text-muted">The address is shared once you&apos;re hired.</p>
      </div>
    </div>
  );
}
