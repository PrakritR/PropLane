"use client";

import { Modal } from "@/components/ui/modal";
import { VendorNotificationSettingsPane } from "@/components/portal/vendor-notification-settings-pane";

/** Settings gear on vendor Services / Communication — same pane as Settings → Notifications. */
export function VendorSectionSettingsModal({
  open,
  title,
  onClose,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onClose} dataAttr="vendor-section-settings">
      <VendorNotificationSettingsPane />
    </Modal>
  );
}
