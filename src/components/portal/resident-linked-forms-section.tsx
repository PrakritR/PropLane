"use client";

import { useEffect, useMemo, useState } from "react";
import { LinkedFormsFinishList } from "@/components/marketing/linked-forms-finish-list";
import { fetchMyLinkedForms, type MyLinkedForms } from "@/lib/linked-form-requests-client";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

function groupByApplicant(forms: readonly LinkedFormRequestView[]): Array<{ name: string; forms: LinkedFormRequestView[] }> {
  const groups = new Map<string, { name: string; forms: LinkedFormRequestView[] }>();
  for (const form of forms) {
    const key = form.applicationId;
    const group = groups.get(key) ?? { name: form.applicantName?.trim() || "an applicant", forms: [] };
    group.forms.push(form);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The resident portal's Applications section: "N more forms to finish" for the person's own applications, and
 * "Forms for <applicant>" for forms they opened a share link for. Draws nothing when nothing is owed.
 */
export function ResidentLinkedFormsSection({ className }: { className?: string }) {
  const [lists, setLists] = useState<MyLinkedForms | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMyLinkedForms().then((next) => {
      if (!cancelled) setLists(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const helping = useMemo(() => groupByApplicant(lists?.helping ?? []), [lists]);
  if (!lists) return null;
  return (
    <div className={className} data-attr="resident-linked-forms">
      <LinkedFormsFinishList forms={lists.own} className="mb-4" />
      {helping.map((group) => (
        <LinkedFormsFinishList
          key={group.forms[0]?.applicationId}
          forms={group.forms}
          heading={`Forms for ${group.name}`}
          allowShare={false}
          className="mb-4"
        />
      ))}
    </div>
  );
}
