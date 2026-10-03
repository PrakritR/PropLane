"use client";

import { useMemo } from "react";
import { useMoveInFormRowActions } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { lateFormNeedsLine, lateMoveInForms } from "@/lib/move-in-forms/manager-rows";
import type { RecordNeedsYouItem } from "@/components/portal/portal-record-overview-kit";

/**
 * One "Needs you" line per late move-in form on a resident's Overview: "<Form> is 2 days late",
 * and the line itself reminds them. Fetches nothing unless `enabled` (the Overview is open for a
 * person who can have forms), and nothing is rendered while the list is loading or has no late form.
 */
export function useResidentMoveInNeedsYou(input: {
  userId: string | null;
  applicationId: string | null;
  residentName: string;
  enabled: boolean;
}): RecordNeedsYouItem[] {
  const { userId, applicationId, residentName, enabled } = input;
  const actions = useMoveInFormRowActions();
  const { list } = useManagerMoveInForms(userId, applicationId ? { applicationId } : {}, enabled && Boolean(applicationId));
  const first = residentName.trim().split(/\s+/)[0] || "them";
  return useMemo(() => {
    if (!enabled || !applicationId) return [];
    return lateMoveInForms(list.forms.filter((form) => form.applicationId === applicationId)).map(({ form, daysLate }) => ({
      id: `move-in-${form.id}`,
      title: lateFormNeedsLine(form.formName, daysLate),
      detail: `Remind ${first}`,
      onClick: () => void actions.remind(form),
    }));
  }, [enabled, applicationId, list.forms, first, actions]);
}
