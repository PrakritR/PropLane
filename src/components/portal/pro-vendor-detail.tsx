"use client";

import { Select } from "@/components/ui/input";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

function vendorPriorityLabel(priority: ManagerVendorRow["vendorPriority"]): string {
  if (priority === "primary") return "Primary";
  if (priority === "secondary") return "Secondary";
  return "Standard";
}

export type VendorDetailEditDraft = {
  active: boolean;
  priority: ManagerVendorRow["vendorPriority"];
};

export function ManagerVendorDetail({
  row,
  editing,
  draft,
  onDraftChange,
  onEditDetails,
}: {
  row: ManagerVendorRow;
  editing: boolean;
  draft: VendorDetailEditDraft | null;
  onDraftChange: (draft: VendorDetailEditDraft) => void;
  onEditDetails: () => void;
}) {
  const active = editing && draft ? draft.active : row.active !== false;
  const priority = editing && draft ? draft.priority : row.vendorPriority;
  const statusLabel = active ? "Active" : "Inactive";

  return (
    <div className="space-y-4 px-3 py-2 text-sm sm:px-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted">Trade</p>
          <p className="text-foreground">{row.trade?.trim() || "—"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Status</p>
          {editing && draft ? (
            <Select
              id={`vendor-status-${row.id}`}
              className="mt-1"
              value={draft.active ? "active" : "inactive"}
              onChange={(e) => onDraftChange({ ...draft, active: e.target.value === "active" })}
              data-attr="vendor-status-select"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          ) : (
            <p className="font-medium text-foreground">{statusLabel}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Priority</p>
          {editing && draft ? (
            <Select
              id={`vendor-priority-${row.id}`}
              className="mt-1"
              value={draft.priority ?? ""}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  priority:
                    e.target.value === "primary" || e.target.value === "secondary" ? e.target.value : undefined,
                })
              }
              data-attr="vendor-priority-select"
            >
              <option value="">Standard</option>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </Select>
          ) : (
            <p className="text-foreground">{vendorPriorityLabel(priority)}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Email</p>
          <p className="text-foreground">{row.email?.trim() || "—"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Phone</p>
          <p className="text-foreground">{row.phone?.trim() || "—"}</p>
        </div>
        {editing ? (
          <p className="text-xs text-muted sm:col-span-2">
            <button
              type="button"
              className="font-semibold text-foreground underline-offset-2 hover:underline"
              data-attr="vendor-edit-details"
              onClick={onEditDetails}
            >
              Edit name, contact, and notes
            </button>
          </p>
        ) : null}
      </div>
      {row.notes ? (
        <div>
          <p className="text-xs font-medium text-muted">Notes</p>
          <p className="leading-relaxed text-foreground/90">{row.notes}</p>
        </div>
      ) : null}
    </div>
  );
}
