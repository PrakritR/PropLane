"use client";

import { useEffect, useState } from "react";
import type { DocumentScope } from "@/lib/reports/types";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

export type FormalDocumentFilterState = {
  scope: DocumentScope;
  propertyId: string;
  residentEmail: string;
  roomLabel: string;
};

type ScopeOptions = {
  properties: { id: string; label: string }[];
  tenants: { email: string; name: string }[];
  rooms: { id: string; label: string }[];
};

export function FormalDocumentScopeBar({
  filters,
  onChange,
  inline = false,
  stacked = false,
}: {
  filters: FormalDocumentFilterState;
  onChange: (next: Partial<FormalDocumentFilterState>) => void;
  /** Render bare controls (no card) that sit inline in a shared portal filter row. */
  inline?: boolean;
  /** Vertical stack for modal forms. */
  stacked?: boolean;
}) {
  const [options, setOptions] = useState<ScopeOptions>({ properties: [], tenants: [], rooms: [] });

  useEffect(() => {
    const qs = filters.propertyId ? `?propertyId=${encodeURIComponent(filters.propertyId)}` : "";
    void fetch(`/api/reports/formal-documents/scope-options${qs}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setOptions(data as ScopeOptions))
      .catch(() => setOptions({ properties: [], tenants: [], rooms: [] }));
  }, [filters.propertyId]);

  const fieldWrapClass = (minWidth: string) => (stacked ? "w-full" : `${minWidth} w-full`);

  const controls = (
    <>
      <FieldSingleSelect
        label="Scope"
        wrapperClassName={fieldWrapClass("min-w-[9rem]")}
        dataAttr="formal-document-scope"
        value={filters.scope}
        onChange={(next) =>
          onChange({
            scope: next as DocumentScope,
            propertyId: "",
            residentEmail: "",
            roomLabel: "",
          })
        }
        options={[
          { value: "portfolio", label: "All properties" },
          { value: "property", label: "Per property" },
          { value: "tenant", label: "Per resident" },
          { value: "room", label: "Per room" },
        ]}
      />

      {filters.scope === "property" || filters.scope === "tenant" || filters.scope === "room" ? (
        <FieldSingleSelect
          label="Property"
          wrapperClassName={fieldWrapClass("min-w-[10rem]")}
          dataAttr="formal-document-property"
          placeholder="Select property"
          value={filters.propertyId}
          onChange={(next) => onChange({ propertyId: next, residentEmail: "", roomLabel: "" })}
          options={[
            { value: "", label: "Select property" },
            ...options.properties.map((p) => ({ value: p.id, label: p.label })),
          ]}
        />
      ) : null}

      {filters.scope === "tenant" ? (
        <FieldSingleSelect
          label="Resident"
          wrapperClassName={fieldWrapClass("min-w-[10rem]")}
          dataAttr="formal-document-tenant"
          placeholder="Select resident"
          value={filters.residentEmail}
          onChange={(next) => onChange({ residentEmail: next })}
          options={[
            { value: "", label: "Select resident" },
            ...options.tenants.map((t) => ({ value: t.email, label: t.name })),
          ]}
        />
      ) : null}

      {filters.scope === "room" ? (
        <FieldSingleSelect
          label="Room / unit"
          wrapperClassName={fieldWrapClass("min-w-[9rem]")}
          dataAttr="formal-document-room"
          placeholder="Select room"
          value={filters.roomLabel}
          onChange={(next) => onChange({ roomLabel: next })}
          options={[
            { value: "", label: "Select room" },
            ...options.rooms.map((r) => ({ value: r.id, label: r.label })),
          ]}
        />
      ) : null}
    </>
  );

  if (inline) {
    return stacked ? <div className="flex flex-col gap-4">{controls}</div> : controls;
  }

  return (
    <div className="rounded-2xl border border-border bg-accent/15 p-4">
      <div className="flex flex-wrap gap-3">{controls}</div>
    </div>
  );
}

export function appendDocumentScopeParams(params: URLSearchParams, scopeFilters: FormalDocumentFilterState): void {
  params.set("scope", scopeFilters.scope);
  if (scopeFilters.propertyId) params.set("propertyId", scopeFilters.propertyId);
  if (scopeFilters.residentEmail) params.set("residentEmail", scopeFilters.residentEmail);
  if (scopeFilters.roomLabel) params.set("roomLabel", scopeFilters.roomLabel);
}

export function buildScopedReportQuery(
  dateFilters: { from: string; to: string },
  scopeFilters: FormalDocumentFilterState,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams(extra);
  params.set("from", dateFilters.from);
  params.set("to", dateFilters.to);
  appendDocumentScopeParams(params, scopeFilters);
  return params.toString();
}

export function buildFormalDocumentQuery(
  kind: "rent_receipt" | "days_rented" | "property_rent_receipt",
  dateFilters: { from: string; to: string },
  scopeFilters: FormalDocumentFilterState,
): string {
  const params = new URLSearchParams();
  params.set("kind", kind);
  appendDocumentScopeParams(params, scopeFilters);
  params.set("from", dateFilters.from);
  params.set("to", dateFilters.to);
  return params.toString();
}
