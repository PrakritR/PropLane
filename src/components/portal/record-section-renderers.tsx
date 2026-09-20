"use client";

import { createElement, type ComponentType } from "react";
import { FileText, Clock3 } from "lucide-react";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";
import { isRecordKind } from "@/lib/portals/record-kinds";

/**
 * The shared trio's content (PLAN-0920-1058, area 1a) — one place a section id
 * resolves to a component, so every record page renders Documents and Activity
 * the same way regardless of role or kind. `communication` registers a
 * placeholder here; worker 1b (area 1b) replaces that ONE registration with
 * the real per-record thread list once storage and send paths carry
 * `recordRef` — nothing else in this file should need to change for that swap.
 */

export type RecordSectionDocument = {
  id: string;
  name: string;
  href: string;
};

export type RecordSectionActivityEvent = {
  id: string;
  label: string;
  timestamp: string;
};

export type RecordSectionRendererProps = {
  role: "manager" | "resident" | "vendor";
  kind: string;
  /** Singular, lowercase noun for empty copy ("charge", "resident", "vendor"). */
  kindLabel: string;
  recordId: string;
  recordLabel?: string;
  /** The existing documents list for this record's property/contact, when one exists. */
  documents?: RecordSectionDocument[];
  onAddDocument?: () => void;
  /** The record's existing status/event history, when it has one. */
  activity?: RecordSectionActivityEvent[];
  /** Narrow the record's Communication to this property / these contacts when the panel knows them. */
  propertyId?: string;
  contactIds?: string[];
};

const renderers = new Map<string, ComponentType<RecordSectionRendererProps>>();

export function registerRecordSectionRenderer(
  id: string,
  Component: ComponentType<RecordSectionRendererProps>,
): void {
  renderers.set(id, Component);
}

export function renderRecordSection(id: string, props: RecordSectionRendererProps) {
  const Component = renderers.get(id);
  if (!Component) return null;
  return createElement(Component, props);
}

function DocumentsSection({ documents, onAddDocument }: RecordSectionRendererProps) {
  if (documents && documents.length > 0) {
    return (
      <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-attr="record-documents-list">
        {documents.map((doc) => (
          <li key={doc.id}>
            <a
              href={doc.href}
              className="flex min-h-11 items-center gap-2.5 px-4 py-3 text-[14px] font-medium text-foreground hover:bg-accent/40"
            >
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="truncate">{doc.name}</span>
            </a>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <PortalListEmptyCard
      title="No documents yet"
      icon={<FileText className="size-[22px]" strokeWidth={1.6} aria-hidden />}
      dataAttr="record-documents-empty"
      workspaceAware={false}
      actions={onAddDocument ? [{ label: "Add document", onClick: onAddDocument, dataAttr: "record-documents-add" }] : []}
    />
  );
}

function ActivitySection({ activity }: RecordSectionRendererProps) {
  if (activity && activity.length > 0) {
    return (
      <ol className="space-y-2.5" data-attr="record-activity-list">
        {activity.map((event) => (
          <li key={event.id} className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-foreground">{event.label}</p>
              <p className="text-[12px] text-muted">{event.timestamp}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <PortalListEmptyCard
      title="No activity yet"
      icon={<Clock3 className="size-[22px]" strokeWidth={1.6} aria-hidden />}
      dataAttr="record-activity-empty"
      workspaceAware={false}
    />
  );
}

/**
 * Communication inside a record: the same inbox, narrowed to threads that carry
 * this record's `recordRef` (docs/agents/communication-inbox.md § recordRef).
 * A panel whose kind is not a `RecordKind` gets the titled empty card so the
 * rail never renders a blank section.
 */
function CommunicationSection({ role, kind, kindLabel, recordId, recordLabel, propertyId, contactIds }: RecordSectionRendererProps) {
  if (!isRecordKind(kind)) {
    return (
      <PortalListEmptyCard
        title={`No messages about this ${kindLabel} yet`}
        dataAttr="record-communication-empty"
        workspaceAware={false}
      />
    );
  }
  return (
    <RecordCommunicationSection
      role={role}
      recordRef={{ kind, id: recordId, label: recordLabel ?? kindLabel }}
      propertyId={propertyId}
      contactIds={contactIds}
    />
  );
}

registerRecordSectionRenderer("documents", DocumentsSection);
registerRecordSectionRenderer("activity", ActivitySection);
registerRecordSectionRenderer("communication", CommunicationSection);
