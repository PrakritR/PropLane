"use client";

import { Modal } from "@/components/ui/modal";
import {
  MANAGER_DASHBOARD_SECTIONS,
} from "@/lib/dashboard-preferences";

/** Accessible on/off switch for a single dashboard section. */
function SectionToggle({
  label,
  description,
  checked,
  onChange,
  dataAttr,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  dataAttr?: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      </div>
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
        className="mt-0.5 inline-flex w-11 shrink-0 items-center justify-center bg-transparent focus-visible:outline-none"
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
  sections?: readonly { id: string; label: string; description: string }[];
}) {
  const visibleCount = sections.filter((s) => visibility[s.id]).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customize dashboard"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onReset}
            data-attr="dashboard-customize-reset"
            className="text-xs font-semibold text-muted hover:text-foreground"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            data-attr="dashboard-customize-done"
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Done
          </button>
        </div>
      }
    >
      <p className="text-xs text-muted">
        Choose which sections appear on your dashboard. {visibleCount} of {sections.length} shown. The stat row at the
        top always stays.
      </p>
      <ul className="mt-3 space-y-2">
        {sections.map((section) => (
          <SectionToggle
            key={section.id}
            label={section.label}
            description={section.description}
            checked={Boolean(visibility[section.id])}
            onChange={(next) => onToggle(section.id, next)}
            dataAttr={`dashboard-customize-toggle-${section.id}`}
          />
        ))}
      </ul>
    </Modal>
  );
}
