"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { sha256HexFromUtf8 } from "@/lib/document-body-sha256";

export function ResidentSignAndPayClient() {
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [documentHash, setDocumentHash] = useState<string | null>(null);
  const leaseBody = useMemo(
    () =>
      "Short-term stay agreement preview — the signed body is locked after you sign and carries the SHA-256 of this exact text.",
    [],
  );

  const onSign = async () => {
    const hash = await sha256HexFromUtf8(leaseBody);
    setDocumentHash(hash);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" data-jr-sp>
      <h1 className="text-xl font-bold text-foreground">Review, sign, and pay</h1>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold text-foreground">Lease document</h2>
        <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-border bg-accent/20 p-3 text-sm text-foreground">
          {leaseBody}
        </div>
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
        <Button type="button" className="mt-4" onClick={() => void onSign()} disabled={!typedName.trim() || !consent}>
          Sign
        </Button>
        {documentHash ? (
          <p className="mt-2 text-xs font-semibold text-muted">Document SHA-256: {documentHash}</p>
        ) : null}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-bold text-foreground">Move-in costs</h2>
        <p className="mt-2 text-sm font-semibold text-foreground">Pay deposit and move-in fees after signing.</p>
        <Link href="/resident/payments?pay=now" className="mt-3 inline-block text-sm font-bold text-primary">
          Open payments
        </Link>
      </section>
    </div>
  );
}
