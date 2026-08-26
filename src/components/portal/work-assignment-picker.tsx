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

  // A vendor who has been deleted, or a co-manager who has been unlinked, still has to be shown on
  // the work they hold — otherwise it reads as unassigned rather than as needing a new owner.
  const stale = assigneeIsStale(value, candidates);
  const selected = value ? `${value.type}:${value.id}` : UNASSIGNED;

  const pick = (raw: string) => {
    if (raw === UNASSIGNED) return onChange(null);
    const [type, ...rest] = raw.split(":");
    const id = rest.join(":");
    const candidate = candidates.find((c) => c.type === type && c.id === id);
    if (!candidate) return;
    // The name is snapshotted so the row still reads sensibly if this person later disappears.
    onChange({ type: candidate.type, id: candidate.id, name: candidate.name });
  };

  const teamOptions = candidates.filter((c) => c.type === "team");
  const vendorOptions = candidates.filter((c) => c.type === "vendor");

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <select
        value={stale ? UNASSIGNED : selected}
        disabled={disabled}
        data-attr={dataAttr}
        onChange={(e) => pick(e.target.value)}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      >
        <option value={UNASSIGNED}>Unassigned</option>
        {teamOptions.length > 0 ? (
          <optgroup label="Team">
            {teamOptions.map((c) => (
              <option key={`team:${c.id}`} value={`team:${c.id}`} disabled={!c.selectable}>
                {optionLabel(c)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {vendorOptions.length > 0 ? (
          <optgroup label="Vendors">
            {vendorOptions.map((c) => (
              <option key={`vendor:${c.id}`} value={`vendor:${c.id}`} disabled={!c.selectable}>
                {optionLabel(c)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {stale && value ? (
        <span className="mt-1 block text-xs text-muted" data-attr={`${dataAttr}-stale`}>
          {value.name || "The previous assignee"} is no longer on your team — reassign this.
        </span>
      ) : null}
    </label>
  );
}

function optionLabel(candidate: AssignmentCandidate): string {
  const suffix = candidate.selectable ? "" : " (inactive)";
  return candidate.detail ? `${candidate.name} · ${candidate.detail}${suffix}` : `${candidate.name}${suffix}`;
}
