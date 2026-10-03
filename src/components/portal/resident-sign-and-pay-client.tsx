"use client";

import Link from "next/link";
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
import { recordApprovedApplicationCharges } from "@/lib/household-charges";
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
        recordApprovedApplicationCharges(frozen.row, app.managerUserId ?? null, true, { leaseExecuted: true });
      }
      showToast("Lease signed. Move-in charges are ready in Payments.");
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
          className="prose prose-sm mt-3 max-h-64 overflow-y-auto rounded-xl border border-border bg-accent/20 p-3 text-sm text-foreground"
          dangerouslySetInnerHTML={{ __html: leaseBody }}
        />
        {loadingDoc ? <p className="mt-2 text-xs font-semibold text-muted">Loading lease…</p> : null}
      </section>
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
          disabled={!typedName.trim() || !consent || signing || loadingDoc || !pipelineRow}
        >
          Sign
        </Button>
        {documentHash ? (
          <p className="mt-2 text-xs font-semibold text-muted">Document SHA-256: {documentHash}</p>
        ) : null}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold text-foreground">Move-in costs</h2>
        <Link href="/resident/payments?pay=now" className="mt-3 inline-flex min-h-11 items-center text-sm font-bold text-primary">
          Open payments
        </Link>
      </section>
    </div>
  );
}
