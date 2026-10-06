"use client";

import { useEffect, useState } from "react";
import { blockingFormsFromRows } from "@/lib/move-in-forms/blocking";
import { loadMoveInForms, MOVE_IN_FORMS_CHANGED } from "@/lib/move-in-forms/client";

/**
 * The forms sent to one applicant that block their approval (`blocks: "approval"`, still unsubmitted).
 * Display only: both approve routes read the forms table themselves and answer 409, so a stale answer
 * here can only show or hide the refusal, never let an approval through.
 */
export function useApprovalFormsBlock(userId: string | null | undefined, applicationId: string): { names: string[]; blocked: boolean } {
  const [state, setState] = useState<{ key: string; names: string[] } | null>(null);
  const key = `${userId ?? ""}:${applicationId}`;
  useEffect(() => {
    if (!userId || !applicationId) return;
    let cancelled = false;
    const read = (force = false) =>
      loadMoveInForms(userId, "manager", { applicationId, status: "sent" }, force)
        .then((value) => {
          if (cancelled) return;
          const rows = value.forms
            .filter((form) => form.applicationId === applicationId)
            .map((form) => ({ id: form.id, form_id: form.formId, status: form.status, sent_at: form.sentAt, snapshot: { kind: form.kind, blocks: form.blocks } }));
          const blockingIds = new Set(rows.filter((row) => blockingFormsFromRows([row]).approval).map((row) => row.id));
          setState({ key, names: value.forms.filter((form) => blockingIds.has(form.id)).map((form) => form.formName) });
        })
        .catch(() => undefined);
    void read();
    const changed = () => void read(true);
    window.addEventListener(MOVE_IN_FORMS_CHANGED, changed);
    return () => {
      cancelled = true;
      window.removeEventListener(MOVE_IN_FORMS_CHANGED, changed);
    };
  }, [userId, applicationId, key]);
  const names = state?.key === key ? state.names : [];
  return { names, blocked: names.length > 0 };
}
