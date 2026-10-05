"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CosignerApplyFlow } from "@/app/(public)/rent/apply/cosigner-flow";
import { Button } from "@/components/ui/button";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";
import { linkedFormFacts } from "@/lib/application-linked-form-requests";
import {
  fetchLinkedFormForFill,
  startLinkedFormFeeCheckout,
  verifyLinkedFormFee,
} from "@/lib/linked-form-requests-client";
import type { ApplicationConfigSlice } from "@/lib/rental-application/application-field-catalog";

type Loaded = Extract<Awaited<ReturnType<typeof fetchLinkedFormForFill>>, { ok: true }>;
type Phase = { kind: "loading" } | { kind: "refused" } | { kind: "signin" } | { kind: "ready"; data: Loaded };

function feeText(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

/**
 * The page a linked form is filled in on. Signed-in people only: the applicant, or the helper who opened the
 * share link. Everything shown, the questions included, comes from the server for THIS request; a person with
 * no access sees the same screen as for a link that does not exist.
 *
 * A form with a fee asks the person filling it in to pay it first, then opens the questions.
 */
export default function LinkedFormFillClient({ requestId }: { requestId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [payError, setPayError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    const loaded = await fetchLinkedFormForFill(requestId);
    if (loaded.ok) setPhase({ kind: "ready", data: loaded });
    else setPhase(loaded.status === 401 ? { kind: "signin" } : { kind: "refused" });
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Stripe: confirm the payment against THIS request, then drop the session id from the address bar.
  const sessionId = searchParams.get("fee_session_id");
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setVerifying(true);
    void (async () => {
      const result = await verifyLinkedFormFee(requestId, sessionId);
      if (cancelled) return;
      if (!result.ok) setPayError(result.error ?? "Could not confirm payment.");
      else if (!result.paid) setPayError("Your payment is still processing. Refresh in a moment.");
      setVerifying(false);
      router.replace(pathname);
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, requestId, router, pathname, load]);

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto max-w-3xl px-4 py-10" data-attr="linked-form-fill">
      {children}
    </div>
  );

  if (phase.kind === "loading") {
    return shell(
      <p className="text-center text-sm text-muted" role="status">
        Opening…
      </p>,
    );
  }
  if (phase.kind === "signin") {
    return shell(
      <div className="text-center">
        <h1 className="text-xl font-bold text-foreground">Sign in to continue</h1>
        <div className="mt-6">
          <Button asChild>
            <Link href={`/auth/sign-in?intent=resident&next=${encodeURIComponent(pathname)}`}>Sign in</Link>
          </Button>
        </div>
      </div>,
    );
  }
  if (phase.kind === "refused") {
    return shell(
      <div className="text-center">
        <h1 className="text-xl font-bold text-foreground">This link can&apos;t be used</h1>
        <div className="mt-6">
          <Button asChild variant="outline">
            <Link href="/">Back to PropLane</Link>
          </Button>
        </div>
      </div>,
    );
  }

  const { request, form } = phase.data;
  return shell(<FillBody request={request} form={form} payError={payError} verifying={verifying} />);
}

function FillBody({
  request,
  form,
  payError,
  verifying,
}: {
  request: LinkedFormRequestView;
  form: Loaded["form"];
  payError: string | null;
  verifying: boolean;
}) {
  const router = useRouter();
  const [startError, setStartError] = useState<string | null>(null);

  if (request.status === "done" || request.status === "not_needed") {
    return (
      <div className="text-center">
        <h1 className="text-xl font-bold text-foreground">
          {request.status === "done" ? "This form is finished" : "This form is no longer needed"}
        </h1>
        <div className="mt-6">
          <Button asChild variant="outline">
            <Link href="/resident/applications">Back to applications</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (request.formKind === "move_in") {
    return (
      <div className="text-center">
        <h1 className="text-xl font-bold text-foreground">{request.formLabel}</h1>
        <div className="mt-6">
          <Button asChild>
            <Link href="/resident/move-in">Open move-in forms</Link>
          </Button>
        </div>
      </div>
    );
  }

  const fee = request.feeCents ?? 0;
  if (fee > 0 && !request.feePaid) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-6 text-center">
        <h1 className="text-xl font-bold text-foreground">{request.formLabel}</h1>
        <ul className="mt-2 flex flex-wrap justify-center gap-x-4 text-[13px] text-muted">
          {linkedFormFacts(request).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <Button
          className="mt-6 w-full"
          data-attr="linked-form-pay-fee"
          disabled={verifying}
          onClick={async () => {
            setStartError(null);
            const started = await startLinkedFormFeeCheckout(request.id);
            if (started.ok) window.location.assign(started.url);
            else setStartError(started.error);
          }}
        >
          {`Pay ${feeText(fee)} to continue`}
        </Button>
        {startError || payError ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {startError ?? payError}
          </p>
        ) : null}
      </div>
    );
  }

  if (!form) {
    return (
      <div className="text-center">
        <h1 className="text-xl font-bold text-foreground">This form is unavailable</h1>
      </div>
    );
  }

  return (
    <CosignerApplyFlow
      onBack={() => router.push("/resident/applications")}
      onDone={() => router.push("/resident/applications")}
      linkedForm={{
        requestId: request.id,
        signerAppId: form.signerAppId,
        signerFullName: form.signerFullName,
        templateId: form.templateId,
        templateVersion: form.templateVersion,
        config: form.config as ApplicationConfigSlice,
      }}
    />
  );
}
