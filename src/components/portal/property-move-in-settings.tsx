"use client";

/**
 * The Settings gear and its "Move-in settings" popup (remind residents, tell me when a form is
 * submitted). The property's Forms tab and its Move-in tab both carry the gear in their header, so
 * the popup lives here once.
 */
import { useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { persistManagerListingSubmissionOnServer, type ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { readMoveInFormSettings } from "@/lib/move-in-forms/templates";
import type { MoveInFormSettings } from "@/lib/move-in-forms/types";

const REMIND_OPTIONS: { value: MoveInFormSettings["remind"]; label: string }[] = [
  { value: "before-and-due", label: "2 days before due and on the due date" },
  { value: "due-only", label: "On the due date only" },
  { value: "never", label: "Never" },
];

const NOTIFY_OPTIONS: { value: MoveInFormSettings["notifyOnSubmit"]; label: string }[] = [
  { value: "assistant", label: "Assistant notice" },
  { value: "assistant-and-email", label: "Assistant notice and email" },
  { value: "none", label: "Don't notify" },
];

export function usePropertyMoveInSettings({
  sub,
  saveTarget,
  managerUserId,
  canEdit,
  onUpdated,
  showToast,
  propertyLabel,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget | null;
  managerUserId: string | null;
  canEdit: boolean;
  onUpdated: () => void;
  showToast: (message: string) => void;
  /** For the popup's "Applies to" row. */
  propertyLabel?: string;
}): { gear: ReactNode; modal: ReactNode } {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<MoveInFormSettings>(() => readMoveInFormSettings(sub));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!managerUserId || !saveTarget || !canEdit) return;
    setSaving(true);
    const ok = await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, { ...sub, moveInFormSettings: settings });
    setSaving(false);
    if (!ok) {
      showToast("Could not save move-in settings.");
      return;
    }
    showToast("Move-in settings saved.");
    setOpen(false);
    onUpdated();
  };

  const gear = (
    <PortalIconAction
      icon={Settings}
      label="Move-in settings"
      data-attr="property-move-in-settings-open"
      onClick={() => {
        setSettings(readMoveInFormSettings(sub));
        setOpen(true);
      }}
    />
  );

  const modal = (
    <PortalPropertySectionSettingsModal
      open={open}
      onClose={() => setOpen(false)}
      title="Move-in settings"
      propertyLabel={propertyLabel ?? "This property"}
      dataAttr="property-move-in-settings"
      onSave={() => void save()}
      saveDisabled={!canEdit || saving}
    >
      <div className="space-y-4">
        <FieldSingleSelect
          label="Remind residents"
          value={settings.remind}
          onChange={(value) => setSettings((prev) => ({ ...prev, remind: value as MoveInFormSettings["remind"] }))}
          options={REMIND_OPTIONS}
          disabled={!canEdit}
          dataAttr="property-move-in-settings-remind"
        />
        <FieldSingleSelect
          label="Tell me when a form is submitted"
          value={settings.notifyOnSubmit}
          onChange={(value) => setSettings((prev) => ({ ...prev, notifyOnSubmit: value as MoveInFormSettings["notifyOnSubmit"] }))}
          options={NOTIFY_OPTIONS}
          disabled={!canEdit}
          dataAttr="property-move-in-settings-notify"
        />
      </div>
    </PortalPropertySectionSettingsModal>
  );

  return { gear, modal };
}
