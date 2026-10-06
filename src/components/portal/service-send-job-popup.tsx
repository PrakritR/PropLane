"use client";

import { useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  JOB_SEND_RADIUS_OPTIONS,
  MAX_VENDORS_PER_JOB_SEND,
  sendBarState,
  type PipelineCandidate,
} from "@/lib/service-pipeline";
import type { PublishMarketplaceOptions } from "@/lib/work-order-vendor-offers";

const STEPS: AddWorkspaceStep[] = [{ id: "send", label: "Send job" }];

/**
 * The standard popup (the New property shell) the Vendors section's round + opens: pick vendors from a
 * dropdown (up to 10), optionally "Also send to PropLane vendors within [5 mi]", Send. For an add-on the host's
 * `onSend` creates the linked vendor job exactly as before; the popup only collects the choice. What a vendor
 * can see before approval is enforced server-side, so nothing here explains it.
 */
export function ServiceSendJobPopup({ open, ...props }: SendJobPopupProps & { open: boolean }) {
  // Mounted only while open, so every open starts from a clean choice.
  return open ? <SendJobPopupBody {...props} /> : null;
}

type SendJobPopupProps = {
  /** Roster vendors the job has not gone to yet (the Available bucket). */
  candidates: readonly PipelineCandidate[];
  /** The job's trade, sent with the marketplace reach. */
  trade: string;
  sending: boolean;
  /** False where the PropLane marketplace cannot be reached (the demo). */
  allowMarketplace: boolean;
  /** Vendors already ticked when it opens (a row's "Send job"). */
  initialVendorIds?: readonly string[];
  onClose: () => void;
  onSend: (vendorIds: string[], marketplace: PublishMarketplaceOptions | undefined) => void | Promise<void>;
};

function SendJobPopupBody({ candidates, trade, sending, allowMarketplace, initialVendorIds, onClose, onSend }: SendJobPopupProps) {
  const [picked, setPicked] = useState<string[]>(() => (initialVendorIds ?? []).slice(0, MAX_VENDORS_PER_JOB_SEND));
  const [marketplace, setMarketplace] = useState(false);
  const [radiusMi, setRadiusMi] = useState<number>(JOB_SEND_RADIUS_OPTIONS[0]);

  const reach = marketplace && allowMarketplace;
  const bar = sendBarState(picked.length, reach);
  const send = async () => {
    if (bar.disabled || sending) return;
    await onSend(picked.slice(0, bar.count), reach ? { enabled: true, trade, radiusMi } : undefined);
    onClose();
  };

  return (
    <AddWorkspace
      title="Send job"
      steps={STEPS}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={picked.length > 0 || marketplace}
      discardTitle="Discard this?"
      discardBody="The job has not been sent. Close and lose your choices?"
      assistantContext="Send a service to vendors."
      assistantScopeKey="Send job"
      lastLabel={bar.label}
      lastDisabled={bar.disabled}
      busy={sending}
      onFinish={() => void send()}
      dataAttrPrefix="service-send"
      finishDataAttr="service-send-job"
    >
      <StepColumn>
        <StepHeading title="Send job" />
        <CheckboxMultiSelect
          label="Vendors"
          options={candidates.map((candidate) => ({ value: candidate.id, label: candidate.trade ? `${candidate.name} · ${candidate.trade}` : candidate.name }))}
          selected={picked}
          onChange={(next) => setPicked(next.slice(0, MAX_VENDORS_PER_JOB_SEND))}
          emptyMenuText="No vendors to send this job to"
          emptyLabel="Choose vendors"
          disabled={sending}
          dataAttr="service-send-vendors"
        />
        {allowMarketplace ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-attr="service-send-marketplace-row">
            <PortalSettingsToggle
              checked={marketplace}
              onChange={setMarketplace}
              label="Also send to PropLane vendors within"
              disabled={sending}
              dataAttr="service-send-marketplace"
            />
            <span className="text-[14px] text-foreground">Also send to PropLane vendors within</span>
            <FieldSingleSelect
              label="Marketplace radius"
              hideLabel
              variant="pill"
              value={String(radiusMi)}
              options={JOB_SEND_RADIUS_OPTIONS.map((mi) => ({ value: String(mi), label: `${mi} mi` }))}
              onChange={(next) => setRadiusMi(Number(next))}
              disabled={sending || !marketplace}
              dataAttr="service-send-marketplace-radius"
            />
          </div>
        ) : null}
      </StepColumn>
    </AddWorkspace>
  );
}
