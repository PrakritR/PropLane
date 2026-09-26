"use client";

import { useMemo, useState } from "react";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  axisAdminScheduleContact,
  propertyOptionsFromContacts,
  residentsForProperty,
} from "@/lib/manager-inbox-contacts";

export type ScheduleRecipientKey =
  | "admin"
  | "broadcast:management"
  | "broadcast:resident"
  | `id:${string}`
  | `property:${string}`;

type Section = "admin" | "management" | "resident";

const SECTION_META: { id: Section; title: string; hint: string }[] = [
  { id: "admin", title: "Admin", hint: "PropLane platform operations" },
  { id: "management", title: "Property managers", hint: "Linked co-managers on your account" },
  { id: "resident", title: "Residents", hint: "Approved residents: filter by property" },
];

function contactLabel(contact: InboxScopedContact): string {
  const property = contact.propertyLabel?.trim();
  return property ? `${contact.name} · ${property}` : `${contact.name} · ${contact.email}`;
}

export function ScheduleInboxRecipientPicker({
  contacts,
  value,
  onChange,
  disabled,
}: {
  contacts: InboxScopedContact[];
  value: ScheduleRecipientKey;
  onChange: (next: ScheduleRecipientKey) => void;
  disabled?: boolean;
}) {
  const adminContact = axisAdminScheduleContact();
  const managers = useMemo(
    () => [...contacts.filter((c) => c.role === "manager")].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [contacts],
  );
  const propertyOptions = useMemo(() => propertyOptionsFromContacts(contacts), [contacts]);
  const [propertyFilter, setPropertyFilter] = useState<string>("");

  const filteredResidents = useMemo(
    () => residentsForProperty(contacts, propertyFilter || null),
    [contacts, propertyFilter],
  );

  return (
    <div className="space-y-3">
      {SECTION_META.map((section) => (
          <details
            key={section.id}
            className="rounded-2xl border border-border bg-accent/20 open:bg-card"
            open={section.id === "admin"}
          >
            <summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">
              <p className="text-sm font-semibold text-foreground">{section.title}</p>
              <p className="mt-0.5 text-xs text-muted">{section.hint}</p>
            </summary>
            <div className="space-y-2 border-t border-border px-4 py-3">
              {section.id === "admin" ? (
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                  <input
                    type="radio"
                    name="schedule-recipient"
                    className="h-4 w-4 shrink-0"
                    checked={value === "admin"}
                    disabled={disabled}
                    onChange={() => onChange("admin")}
                  />
                  <span>
                    <span className="text-sm font-medium text-foreground">{adminContact.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">{adminContact.email}</span>
                  </span>
                </label>
              ) : null}

              {section.id === "management" ? (
                <>
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                    <input
                      type="radio"
                      name="schedule-recipient"
                      className="h-4 w-4 shrink-0"
                      checked={value === "broadcast:management"}
                      disabled={disabled}
                      onChange={() => onChange("broadcast:management")}
                    />
                    <span className="text-sm font-medium text-foreground">All property managers</span>
                  </label>
                  {managers.length > 0 ? (
                    <ul className="max-h-36 space-y-2 overflow-y-auto">
                      {managers.map((contact) => (
                        <li key={contact.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                            <input
                              type="radio"
                              name="schedule-recipient"
                              className="h-4 w-4 shrink-0"
                              checked={value === `id:${contact.id}`}
                              disabled={disabled}
                              onChange={() => onChange(`id:${contact.id}`)}
                            />
                            <span>
                              <span className="text-sm font-medium text-foreground">{contact.name}</span>
                              <span className="mt-0.5 block text-xs text-muted">{contact.email}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">No linked co-managers yet.</p>
                  )}
                </>
              ) : null}

              {section.id === "resident" ? (
                <>
                  {propertyOptions.length > 0 ? (
                    <FieldSingleSelect
                      label="Property"
                      dataAttr="schedule-recipient-property-filter"
                      value={propertyFilter}
                      disabled={disabled}
                      onChange={setPropertyFilter}
                      options={[
                        { value: "", label: "All properties" },
                        ...propertyOptions.map((property) => ({ value: property.id, label: property.label })),
                      ]}
                    />
                  ) : null}
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                    <input
                      type="radio"
                      name="schedule-recipient"
                      className="h-4 w-4 shrink-0"
                      checked={value === "broadcast:resident"}
                      disabled={disabled}
                      onChange={() => onChange("broadcast:resident")}
                    />
                    <span className="text-sm font-medium text-foreground">All residents</span>
                  </label>
                  {propertyFilter ? (
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                      <input
                        type="radio"
                        name="schedule-recipient"
                        className="h-4 w-4 shrink-0"
                        checked={value === `property:${propertyFilter}`}
                        disabled={disabled}
                        onChange={() => onChange(`property:${propertyFilter}`)}
                      />
                      <span className="text-sm font-medium text-foreground">
                        All residents at {propertyOptions.find((p) => p.id === propertyFilter)?.label ?? "this property"}
                      </span>
                    </label>
                  ) : null}
                  {filteredResidents.length > 0 ? (
                    <ul className="max-h-40 space-y-2 overflow-y-auto">
                      {filteredResidents.map((contact) => (
                        <li key={contact.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                            <input
                              type="radio"
                              name="schedule-recipient"
                              className="h-4 w-4 shrink-0"
                              checked={value === `id:${contact.id}`}
                              disabled={disabled}
                              onChange={() => onChange(`id:${contact.id}`)}
                            />
                            <span>
                              <span className="text-sm font-medium text-foreground">{contactLabel(contact)}</span>
                              <span className="mt-0.5 block text-xs text-muted">{contact.email}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">No approved residents{propertyFilter ? " for this property" : ""} yet.</p>
                  )}
                </>
              ) : null}
            </div>
          </details>
      ))}
    </div>
  );
}
