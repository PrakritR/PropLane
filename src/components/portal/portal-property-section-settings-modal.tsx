"use client";

import { Home } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";

/**
 * The gear modal every property section's Settings icon opens (S016): a fixed
 * "Applies to: <property>" scope row (never a picker — the section is already
 * scoped to this one property) followed by whatever fields that section's
 * gear genuinely has backing storage for. A section with nothing configurable
 * yet still gets this shell with an empty body rather than no gear at all.
 */
export function PortalPropertySectionSettingsModal({
  open,
  onClose,
  title,
  propertyLabel,
  children,
  onSave,
  saveLabel = "Save",
  saveDisabled,
  dataAttr,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  propertyLabel: string;
  children: ReactNode;
  /** Omitted when the modal has nothing to persist (an honest-empty settings surface). */
  onSave?: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      dense
      panelClassName="max-w-lg"
      footer={
        onSave ? (
          <ModalFooter>
            <Button type="button" variant="primary" onClick={onSave} disabled={saveDisabled}>
              {saveLabel}
            </Button>
          </ModalFooter>
        ) : undefined
      }
    >
      <div className="space-y-4" data-attr={dataAttr}>
        <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-2.5">
          <span className="text-[13.5px] font-semibold text-foreground">Applies to</span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[13.5px] font-semibold text-foreground">
            <Home className="size-[15px] shrink-0 text-muted" aria-hidden />
            <span className="truncate">{propertyLabel}</span>
          </span>
        </div>
        {children}
      </div>
    </Modal>
  );
}

PortalPropertySectionSettingsModal.displayName = "PortalPropertySectionSettingsModal";
