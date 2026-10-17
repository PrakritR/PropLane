"use client";

import { RotateCcw } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Modal } from "@/components/ui/modal";
import {
  MANAGER_DASHBOARD_SECTIONS,
} from "@/lib/dashboard-preferences";

/** Accessible on/off switch for a single dashboard section. */
function SectionToggle({
  label,
  checked,
  onChange,
  dataAttr,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  dataAttr?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="min-w-0 text-sm font-semibold text-foreground">{label}</p>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${checked ? "Hide" : "Show"} ${label}`}
        data-attr={dataAttr}
        onClick={() => onChange(!checked)}
        /* The portal HIG layer forces every button in the shell to a 44px
           min-height, so the pill has to be a child — sizing the button itself
           stretches it into a circle. The button stays the touch target. */
        className="inline-flex w-11 shrink-0 items-center justify-center bg-transparent focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={`relative block h-6 w-11 rounded-full transition-colors duration-200 ${
            checked ? "bg-primary" : "bg-[var(--secondary)] border border-border"
          }`}
        >
          <span
            className={`absolute top-0.5 inline-block size-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
              checked ? "left-[1.375rem]" : "left-0.5"
            }`}
          />
        </span>
      </button>
    </li>
  );
}

/**
 * Per-user dashboard customization. A simple toggle list of the available
 * sections — no drag-and-drop layout engine. Changes persist immediately
 * (per user) via the visibility store, so the dashboard behind the modal
 * updates live as toggles flip.
 */
export function DashboardCustomizeModal({
  open,
  onClose,
  visibility,
  onToggle,
  onReset,
  sections = MANAGER_DASHBOARD_SECTIONS,
}: {
  open: boolean;
  onClose: () => void;
  visibility: Record<string, boolean>;
  onToggle: (id: string, visible: boolean) => void;
  onReset: () => void;
  sections?: readonly { id: string; label: string }[];
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customize dashboard"
      status={<PortalIconAction icon={RotateCcw} label="Reset to defaults" onClick={onReset} data-attr="dashboard-customize-reset" />}
    >
      <ul className="space-y-2">
        {sections.map((section) => (
          <SectionToggle
            key={section.id}
            label={section.label}
            checked={Boolean(visibility[section.id])}
            onChange={(next) => onToggle(section.id, next)}
            dataAttr={`dashboard-customize-toggle-${section.id}`}
          />
        ))}
      </ul>
    </Modal>
  );
}
