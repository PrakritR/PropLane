"use client";

/**
 * Minimal renderer registry for the one-portal-system record shell
 * (PLAN-0920-1058). Worker 1A owns this file's full shape (the
 * `record-sections.ts` registry drives which sections a record shows; this
 * file is what turns a section id into an actual component). It is created
 * here — by 1B — only because record-linked communication needs to register
 * itself before 1A's version lands; the merge should keep both sides'
 * registrations rather than picking one file over the other.
 *
 * Anything other than `registerRecordSectionRenderer` / `renderRecordSection`
 * / the `communication` registration below belongs in 1A's pass.
 */
import type { ComponentType } from "react";

export type RecordSectionRendererProps = Record<string, unknown>;

const renderers = new Map<string, ComponentType<RecordSectionRendererProps>>();

export function registerRecordSectionRenderer(
  id: string,
  component: ComponentType<RecordSectionRendererProps>,
): void {
  renderers.set(id, component);
}

export function getRecordSectionRenderer(
  id: string,
): ComponentType<RecordSectionRendererProps> | undefined {
  return renderers.get(id);
}

export function renderRecordSection(id: string, props: RecordSectionRendererProps) {
  const Component = renderers.get(id);
  if (!Component) return null;
  return <Component {...props} />;
}

import { RecordCommunicationSection } from "@/components/portal/record-communication-section";

registerRecordSectionRenderer(
  "communication",
  RecordCommunicationSection as unknown as ComponentType<RecordSectionRendererProps>,
);
