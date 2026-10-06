"use client";

import { useEffect, useState } from "react";
import { loadMoveInForms, MOVE_IN_FORMS_CHANGED } from "@/lib/move-in-forms/client";
import { blockingFormsFromRows } from "@/lib/move-in-forms/blocking";

/**
 * Whether an unsubmitted form of the resident's blocks signing their lease, and which form unlocks it.
 * Display only: the lease route reads the forms table itself and answers 409, so a stale answer here can
 * only show or hide the "Finish your forms first" step, never let a signature through.
 */
export function useResidentFormsBlock(userId: string | null | undefined, enabled: boolean): { blocked: boolean; formId: string | null } {
  const [state, setState] = useState<{ blocked: boolean; formId: string | null }>({ blocked: false, formId: null });
  useEffect(() => {
    if (!enabled || !userId) return;
    let cancelled = false;
    const read = (force = false) =>
      loadMoveInForms(userId, "resident", {}, force)
        .then((value) => {
          if (cancelled) return;
          const result = blockingFormsFromRows(
            value.forms.map((form) => ({
              id: form.id,
              form_id: form.formId,
              status: form.status,
              sent_at: form.sentAt,
              snapshot: { kind: form.kind, blocks: form.blocks },
            })),
          );
          setState({ blocked: result.leaseSigning, formId: result.formIds?.leaseSigning ?? null });
        })
        .catch(() => undefined);
    void read();
    const changed = () => void read(true);
    window.addEventListener(MOVE_IN_FORMS_CHANGED, changed);
    return () => {
      cancelled = true;
      window.removeEventListener(MOVE_IN_FORMS_CHANGED, changed);
    };
  }, [userId, enabled]);
  return enabled ? state : { blocked: false, formId: null };
}
