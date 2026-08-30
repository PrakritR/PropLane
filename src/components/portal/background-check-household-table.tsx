"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  backgroundCheckStatusLabel,
  type ScreeningSubject,
} from "@/lib/background-check-subjects";

export function BackgroundCheckHouseholdTable({
  subjects,
  viewSubjectId,
  onViewSubjectChange,
  selectedSubjectIds,
  onSelectedSubjectIdsChange,
  onRequestChecks,
  requestBusy = false,
  mode = "full",
}: {
  subjects: ScreeningSubject[];
  viewSubjectId: string;
  onViewSubjectChange: (subjectId: string) => void;
  selectedSubjectIds: Set<string>;
  onSelectedSubjectIdsChange: (next: Set<string>) => void;
  onRequestChecks?: () => void;
  requestBusy?: boolean;
  /** `view-only` hides bulk selection — for picking who to screen in a modal. */
  mode?: "full" | "view-only";
}) {
  const showBulkActions = mode === "full";
  const selectableIds = useMemo(
    () => subjects.filter((s) => s.consentCredit).map((s) => s.id),
    [subjects],
  );

  if (subjects.length <= 1) return null;

  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selectedSubjectIds.has(id));
  const someSelected = selectableIds.some((id) => selectedSubjectIds.has(id));

  const toggleAll = () => {
    if (allSelected) {
      onSelectedSubjectIdsChange(new Set());
      return;
    }
    onSelectedSubjectIdsChange(new Set(selectableIds));
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedSubjectIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedSubjectIdsChange(next);
  };

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card"
      data-attr="background-check-household-table"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs font-semibold uppercase tracking-wide text-muted">
              {showBulkActions ? (
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    aria-label="Select all household members for screening"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={toggleAll}
                    disabled={selectableIds.length === 0}
                  />
                </th>
              ) : null}
              <th className="px-3 py-2.5">Name</th>
              <th className="px-3 py-2.5">Type</th>
              <th className="px-3 py-2.5">Background check</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((subject) => {
              const isViewing = subject.id === viewSubjectId;
              const status = backgroundCheckStatusLabel(subject.backgroundCheck);
              const canSelect = subject.consentCredit;
              return (
                <tr
                  key={subject.id}
                  className={`border-b border-border last:border-b-0 ${
                    isViewing ? "bg-primary/5" : "hover:bg-accent/30"
                  }`}
                >
                  {showBulkActions ? (
                    <td className="px-3 py-2.5 align-middle">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border"
                        aria-label={`Select ${subject.label} for screening`}
                        checked={selectedSubjectIds.has(subject.id)}
                        disabled={!canSelect}
                        onChange={() => toggleOne(subject.id)}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 align-middle">
                    <button
                      type="button"
                      className={`text-left font-medium ${
                        isViewing ? "text-primary" : "text-foreground hover:underline"
                      }`}
                      data-attr="background-check-subject-row"
                      onClick={() => onViewSubjectChange(subject.id)}
                    >
                      {subject.label}
                    </button>
                    {!canSelect ? (
                      <p className="mt-0.5 text-xs text-muted">Credit check not authorized</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <Badge tone={subject.type === "signer" ? "info" : "neutral"}>
                      {subject.type === "signer" ? "Signer" : "Co-signer"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 align-middle text-muted">{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showBulkActions && onRequestChecks ? (
        <div className="flex justify-end border-t border-border px-3 py-2.5">
          <Button
            type="button"
            variant="primary"
            className="h-9 rounded-full px-4 text-xs"
            data-attr="request-background-checks"
            disabled={requestBusy || selectedSubjectIds.size === 0}
            onClick={onRequestChecks}
          >
            {requestBusy
              ? "Opening…"
              : selectedSubjectIds.size === 1
                ? "Request background check"
                : "Request background checks"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
