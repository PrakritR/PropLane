"use client";

/**
 * "Who is doing this" — one picker for services, tours and tasks.
 *
 * Which people it offers is decided by `assignableKindsFor` in `work-assignment.ts`, not here:
 * a vendor can take staff TASK work but never a tour or an add-on service. Keeping that rule in
 * the model rather than in each picker is what stops a new surface from quietly offering a vendor
 * a tour.
 */
import { useMemo } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import {
  assigneeIsStale,
  assignmentCandidatesFor,
  type AssignableWorkKind,
  type AssignmentCandidate,
  type WorkAssignee,
} from "@/lib/work-assignment";

const UNASSIGNED = "__unassigned__";

export function WorkAssignmentPicker({
  kind,
  value,
  teamMembers,
  vendors,
  disabled = false,
  onChange,
  label = "Assigned to",
  dataAttr = "work-assignment-picker",
}: {
  kind: AssignableWorkKind;
  value: WorkAssignee | null;
  teamMembers: readonly { userId: string; name?: string | null; email?: string | null }[];
  vendors: readonly { id: string; name?: string | null; trade?: string | null; active?: boolean }[];
  disabled?: boolean;
  onChange: (next: WorkAssignee | null) => void;
  label?: string;
  dataAttr?: string;
}) {
  const candidates = useMemo(
    () => assignmentCandidatesFor(kind, { teamMembers, vendors }),
    [kind, teamMembers, vendors],
  );

  const stale = assigneeIsStale(value, candidates);
  const selected = value ? `${value.type}:${value.id}` : UNASSIGNED;

  const groups = useMemo(() => {
    const teamOptions = candidates
      .filter((candidate) => candidate.type === "team")
      .map((candidate) => ({
        value: `team:${candidate.id}`,
        label: optionLabel(candidate),
        disabled: !candidate.selectable,
      }));
    const vendorOptions = candidates
      .filter((candidate) => candidate.type === "vendor")
      .map((candidate) => ({
        value: `vendor:${candidate.id}`,
        label: optionLabel(candidate),
        disabled: !candidate.selectable,
      }));

    const next = [];
    if (teamOptions.length > 0) next.push({ label: "Team", options: teamOptions });
    if (vendorOptions.length > 0) next.push({ label: "Vendors", options: vendorOptions });
    return next;
  }, [candidates]);

  const pick = (raw: string) => {
    if (raw === UNASSIGNED) return onChange(null);
    const [type, ...rest] = raw.split(":");
    const id = rest.join(":");
    const candidate = candidates.find((candidate) => candidate.type === type && candidate.id === id);
    if (!candidate) return;
    onChange({ type: candidate.type, id: candidate.id, name: candidate.name });
  };

  return (
    <div>
      <FieldSingleSelect
        label={label}
        labelClassName={MODAL_FIELD_LABEL_CLASS}
        value={stale ? UNASSIGNED : selected}
        onChange={pick}
        disabled={disabled}
        placeholder="Unassigned"
        groups={[
          {
            label: "",
            options: [{ value: UNASSIGNED, label: "Unassigned" }],
          },
          ...groups,
        ]}
        dataAttr={dataAttr}
      />
      {stale && value ? (
        <span className="mt-1 block text-xs text-muted" data-attr={`${dataAttr}-stale`}>
          {value.name || "The previous assignee"} is no longer on your team — reassign this.
        </span>
      ) : null}
    </div>
  );
}

function optionLabel(candidate: AssignmentCandidate): string {
  const suffix = candidate.selectable ? "" : " (inactive)";
  return candidate.detail ? `${candidate.name} · ${candidate.detail}${suffix}` : `${candidate.name}${suffix}`;
}
