"use client";

import { useEffect, useState } from "react";
import { LinkedFormsFinishList } from "@/components/marketing/linked-forms-finish-list";
import { fetchLinkedFormsForApplicationResult } from "@/lib/linked-form-requests-client";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

/** Only a server-authorized form request can provide a co-signer invitation. */
export function CosignerInviteCallout({ signerAppId, className, pendingSubmit = false }: {
  signerAppId: string;
  className?: string;
  pendingSubmit?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ applicationId: string; forms: LinkedFormRequestView[] | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (pendingSubmit) return;
    let cancelled = false;
    void fetchLinkedFormsForApplicationResult(signerAppId).then((result) => {
      if (!cancelled) setLoaded({ applicationId: signerAppId, forms: result.ok ? result.requests.filter((request) => request.formKind === "application" && (
        request.ruleId === "lfr-derived-cosigner" || /co.?signer/i.test(request.sourceQuestionLabel)
      )) : null });
    });
    return () => { cancelled = true; };
  }, [signerAppId, pendingSubmit, attempt]);
  if (pendingSubmit) return <div className={className} role="status">Co-signer invitation available after you submit</div>;
  if (!loaded || loaded.applicationId !== signerAppId) return <div className={className} role="status">Loading co-signer invitation…</div>;
  if (!loaded.forms) return <div className={className}><p role="alert">Could not load the co-signer invitation.</p><button type="button" className="mt-2 font-semibold text-primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>;
  const forms = loaded.forms;
  if (!forms.length) return <div className={className} role="status">Ask your property manager to add a co-signer form.</div>;
  const open = forms.filter((form) => form.status === "owed" || form.status === "shared");
  if (!open.length) return <div className={className}>Co-signer form {forms.some((form) => form.status === "done") ? "submitted" : "no longer needed"}</div>;
  return <LinkedFormsFinishList forms={open.map((form) => ({ ...form, requiresHelper: true }))} heading="Co-signer invitation" className={className} />;
}
