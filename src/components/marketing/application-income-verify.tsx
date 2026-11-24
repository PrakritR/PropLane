"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PlaidLinkLauncher, type PlaidLinkSuccess } from "@/components/portal/plaid-link-button";
import { incomeVerifiedLine } from "@/lib/screening/income-verification";

type Verified = { monthlyIncomeCents: number; months: number; depositCount: number; historyDays?: number | null };

/**
 * The applicant's "Verify income" offer on the Work and income step. It draws nothing unless the server says this
 * listing offers it to this signed-in applicant (Plaid on, setting on, a session): a guest, a disabled Plaid and a
 * listing without the setting all see the step exactly as before. Skipping is always allowed and never blocks the
 * submit; the verified figure is computed and stored on the server, never sent from here.
 */
export function ApplicationIncomeVerify({ propertyId }: { propertyId: string }) {
  const [offered, setOffered] = useState(false);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!propertyId.trim()) return;
    void (async () => {
      try {
        const res = await fetch(`/api/screening/income?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "include", cache: "no-store" });
        const data = (await res.json()) as { offered?: boolean; verified?: Verified | null };
        if (!live) return;
        setOffered(res.ok && data.offered === true);
        setVerified(data.verified ?? null);
      } catch {
        if (live) setOffered(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [propertyId]);

  if (!offered) return null;

  const verify = async (result: PlaidLinkSuccess) => {
    setError(null);
    const res = await fetch("/api/plaid/income/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicToken: result.publicToken, propertyId }),
    });
    const data = (await res.json().catch(() => ({}))) as { verified?: Verified; error?: string };
    if (!res.ok || !data.verified) {
      setError(data.error ?? "Couldn't reach your bank.");
      return;
    }
    setVerified(data.verified);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6" data-attr="application-income-verify">
      <p className="text-sm font-semibold text-foreground">Verify income</p>
      {verified ? (
        <p className="text-sm font-medium text-foreground" data-attr="application-income-verified">
          {incomeVerifiedLine({ source: "plaid", verifiedAt: "", ...verified })}
        </p>
      ) : skipped ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <PlaidLinkLauncher
            purpose="income"
            endpoint="/api/plaid/income/link-token"
            linkBody={{ propertyId }}
            onSuccess={verify}
            onError={setError}
          >
            {({ start, busy }) => (
              <Button type="button" variant="secondary" loading={busy} onClick={() => start()} data-attr="application-income-link-bank">
                Link bank
              </Button>
            )}
          </PlaidLinkLauncher>
          <Button type="button" variant="ghost" onClick={() => setSkipped(true)} data-attr="application-income-skip">
            Skip and upload pay stubs
          </Button>
        </div>
      )}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
