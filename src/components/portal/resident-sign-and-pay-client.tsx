"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { sha256HexFromUtf8 } from "@/lib/document-body-sha256";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ensureLeaseDocumentLoaded,
  findLeaseForResidentEmail,
  LEASE_PIPELINE_EVENT,
  residentSignLease,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { buildResidentLeaseDocumentRows, resolveResidentLeaseDocumentView } from "@/lib/resident-lease-documents";
import { HOUSEHOLD_CHARGES_EVENT, recordApprovedApplicationCharges } from "@/lib/household-charges";
import { ResidentSignAndPayMoveIn } from "@/components/portal/resident-sign-and-pay-move-in";
import { useResidentAtSigning } from "@/hooks/use-resident-at-signing";
import { AT_SIGNING_UNPAID_MESSAGE } from "@/lib/lease-at-signing";
import { leaseHtmlForScopedDomDisplay } from "@/lib/lease-html-sections";
import { freezeSignedLeaseTerms, persistFrozenSignedLeaseTerms } from "@/lib/lease-signed-terms";
import { normalizeApplicationAxisId, readManagerApplicationRows } from "@/lib/manager-applications-storage";

export function ResidentSignAndPayClient() {
  const session = usePortalSession();
  const { showToast } = useAppUi();
  const email = session.email?.trim().toLowerCase() ?? "";
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [signedDocument, setSignedDocument] = useState<{ key: string; hash: string } | null>(null);
  const [signing, setSigning] = useState(false);
  const [leaseHtml, setLeaseHtml] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(true);

  const pipelineRow = useMemo(
    () => (email ? findLeaseForResidentEmail(email) : null),
    [email],
  );
  const residentSigned = Boolean(pipelineRow?.residentSignature?.signedAtIso || pipelineRow?.signedAtIso);
  // Pay first: everything due at signing is one Stripe payment, and Sign stays off until the webhook
  // has marked every line paid. A lease that is already signed has nothing left to gate.
  const atSigning = useResidentAtSigning(residentSigned ? null : pipelineRow, email, session.userId);
  const signBlocked = !residentSigned && atSigning.blocked;

  const loadDocument = useCallback(async () => {
    if (!email || !pipelineRow) {
      setLeaseHtml(null);
      setLoadingDoc(false);
      return;
    }
    setLoadingDoc(true);
    try {
      let row = pipelineRow;
      await ensureLeaseDocumentLoaded(row.id, undefined, row);
      await syncLeasePipelineFromServer(null, { force: true });
      row = findLeaseForResidentEmail(email) ?? row;
      const detailRows = buildResidentLeaseDocumentRows(row);
      const detailId = detailRows[0]?.id;
      const view = detailId ? resolveResidentLeaseDocumentView(row, detailId) : null;
      setLeaseHtml(view?.leaseHtml ?? null);
    } finally {
      setLoadingDoc(false);
    }
  }, [email, pipelineRow]);

  useEffect(() => {
    void loadDocument();
    const onLease = () => void loadDocument();
    window.addEventListener(LEASE_PIPELINE_EVENT, onLease);
    return () => window.removeEventListener(LEASE_PIPELINE_EVENT, onLease);
  }, [loadDocument]);

  const leaseBody = leaseHtml?.trim() || "Your lease document is loading…";
  const documentFingerprint = `${typedName.trim()}::${leaseBody}`;
  const documentHash =
    signedDocument?.key === documentFingerprint ? signedDocument.hash : null;

  const onSign = async () => {
    if (!email || !pipelineRow || !consent) return;
    if (signBlocked) {
      showToast(AT_SIGNING_UNPAID_MESSAGE);
      return;
    }
    setSigning(true);
    try {
      const hash = await sha256HexFromUtf8(leaseBody);
      setSignedDocument({ key: documentFingerprint, hash });
      const result = await residentSignLease(email, typedName.trim(), "resident-sign-and-pay-v1");
      if (!result.ok) {
        showToast(result.error ?? "Could not sign the lease.");
        return;
      }
      const axisId = pipelineRow.axisId ? normalizeApplicationAxisId(pipelineRow.axisId) : "";
      const app = readManagerApplicationRows().find(
        (a) =>
          (axisId && normalizeApplicationAxisId(a.id) === axisId) ||
          (email && a.email?.trim().toLowerCase() === email),
      );
      if (app) {
        const frozen = freezeSignedLeaseTerms(app, { managerUserId: app.managerUserId ?? null, lease: pipelineRow });
        if (frozen.changed) persistFrozenSignedLeaseTerms([frozen.row]);
        recordApprovedApplicationCharges(frozen.row, app.managerUserId ?? null, true, {
          leaseExecuted: false,
          moveInAtResidentSign: true,
        });
        window.dispatchEvent(new Event(HOUSEHOLD_CHARGES_EVENT));
      }
      showToast("Lease signed. Pay move-in costs below.");
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" data-jr-sp>
      <h1 className="text-xl font-bold text-foreground">Review, sign, and pay</h1>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold text-foreground">Lease document</h2>
        <div
          className="resident-lease-doc prose prose-sm mt-3 max-h-64 overflow-y-auto rounded-xl border border-border bg-accent/20 p-3 text-sm text-foreground"
          // Display only: the lease's own stylesheet is scoped to this box so it cannot restyle the page.
          // The signature hash above is computed from `leaseBody`, which this does not touch.
          dangerouslySetInnerHTML={{ __html: leaseHtmlForScopedDomDisplay(leaseBody, ".resident-lease-doc", { dropRootLayout: true }) }}
        />
        {loadingDoc ? <p className="mt-2 text-xs font-semibold text-muted">Loading lease…</p> : null}
      </section>
      {!residentSigned && atSigning.charges.length > 0 ? (
        <ResidentSignAndPayMoveIn
          email={email}
          signed={false}
          mode="at-signing"
          charges={atSigning.charges}
          leaseId={pipelineRow?.id ?? null}
          onFeeWaived={() => void atSigning.refresh()}
          onCheckoutComplete={() => {
            void atSigning.waitForSettled().then((settled) => {
              showToast(settled ? "Payment received. You can sign now." : "Payment submitted. Signing opens when it clears.");
            });
          }}
        />
      ) : null}
      <section className="rounded-2xl border border-border bg-card p-4">
        <label className="block text-sm font-bold text-foreground">
          Type your full name
          <input
            className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
          />
        </label>
        <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I agree to sign electronically
        </label>
        <Button
          type="button"
          className="mt-4 min-h-11"
          onClick={() => void onSign()}
          disabled={!typedName.trim() || !consent || signing || loadingDoc || !pipelineRow || signBlocked}
          data-attr="resident-sign-and-pay-sign"
        >
          Sign
        </Button>

        {documentHash ? (
          <p className="mt-2 text-xs font-semibold text-muted">Document SHA-256: {documentHash}</p>
        ) : null}
      </section>
      <ResidentSignAndPayMoveIn email={email} signed={residentSigned || Boolean(documentHash)} />
    </div>
  );
}
