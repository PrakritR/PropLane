"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace } from "@/components/portal/add-workspace";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { SendListingLinkRow } from "@/components/portal/zillow-rental-network-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { logDemoOutboundEmail } from "@/lib/demo-outbound-mail";
import {
  buildLeadInviteEmailBody,
  leadInviteSubject,
  buildLeadInviteSmsText,
} from "@/lib/lead-invite-email";
import {
  buildManagerBrowseUrl,
  buildManagerListingUrl,
  copyTextToClipboard,
} from "@/lib/manager-property-links";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  portalMessageChannelsFromSelection,
  PortalMessageSendViaDropdown,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
} from "@/components/portal/portal-message-compose-fields";
import type { NotificationDeliveryChannels } from "@/components/portal/portal-notification-preview-modal";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";

const STEPS = [
  { id: "listings", label: "Listings" },
  { id: "recipient", label: "Recipient" },
  { id: "review", label: "Review" },
] as const;

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

export function SendLeadListingWizard({
  open,
  onClose,
  properties,
  preselectedPropertyId,
  preselectedPropertyIds,
}: {
  open: boolean;
  onClose: () => void;
  properties: ManagerPropertyFilterOption[];
  preselectedPropertyId?: string;
  preselectedPropertyIds?: string[];
}) {
  const { showToast } = useAppUi();
  const multiEnabled = properties.length > 1;
  const [step, setStep] = useState(0);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [prospectName, setProspectName] = useState("");
  const [prospectEmail, setProspectEmail] = useState("");
  const [prospectPhone, setProspectPhone] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [note, setNote] = useState("");
  const [sendPreviewOpen, setSendPreviewOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setStep(0);
    const knownIds = new Set(properties.map((p) => p.id));
    const preselectedMany = (preselectedPropertyIds ?? []).filter((id) => knownIds.has(id));
    if (preselectedMany.length > 0) {
      setPropertyIds(preselectedMany);
    } else {
      const initialId =
        preselectedPropertyId && knownIds.has(preselectedPropertyId)
          ? preselectedPropertyId
          : properties[0]?.id ?? "";
      setPropertyIds(initialId ? [initialId] : []);
    }
    setProspectName("");
    setProspectEmail("");
    setProspectPhone("");
    setSendVia(["email"]);
    setNote("");
    setSendPreviewOpen(false);
    setSendBusy(false);
  }, [open, preselectedPropertyId, preselectedPropertyIds, properties]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!active || !body) return;
        const payload = normalizeManagerSmsConversationsPayload(body);
        setSmsAvailable(Boolean(payload.workNumber?.trim()));
      })
      .catch(() => {
        if (active) setSmsAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const singlePropertyId = propertyIds.length === 1 ? propertyIds[0] : "";
  const isMultiListing = propertyIds.length > 1;

  const linkUrl = useMemo(() => {
    if (propertyIds.length === 0 || typeof window === "undefined") return "";
    const origin = window.location.origin;
    if (isMultiListing) return buildManagerBrowseUrl(origin, propertyIds);
    if (!singlePropertyId) return "";
    return buildManagerListingUrl(origin, singlePropertyId);
  }, [propertyIds, isMultiListing, singlePropertyId]);

  const propertyTitle = useMemo(() => {
    if (isMultiListing) return `${propertyIds.length} homes`;
    if (!singlePropertyId) return "";
    return properties.find((p) => p.id === singlePropertyId)?.label ?? singlePropertyId;
  }, [properties, singlePropertyId, isMultiListing, propertyIds.length]);

  const listingSummary = useMemo(() => {
    if (isMultiListing || !singlePropertyId) return null;
    const property = getPropertyById(singlePropertyId);
    if (!property) return null;
    return buildListingShareSummary(property);
  }, [singlePropertyId, isMultiListing]);

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const invitePreviewBody = useMemo(() => {
    if (!linkUrl) return "";
    return buildLeadInviteEmailBody({
      kind: "listing",
      prospectName: prospectName.trim() || undefined,
      propertyTitle,
      linkUrl,
      listingCount: isMultiListing ? propertyIds.length : undefined,
      listingPageUrl: linkUrl,
      listingSummary: listingSummary ?? undefined,
      managerNote: note.trim() || undefined,
    });
  }, [linkUrl, prospectName, propertyTitle, isMultiListing, propertyIds.length, listingSummary, note]);

  const handleCopy = async (text: string, successMessage: string) => {
    if (!text) {
      showToast("Select a property first.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? successMessage : "Could not copy link.");
  };

  const sendInvite = async (channels?: NotificationDeliveryChannels) => {
    const deliverEmail = channels?.viaEmail ?? viaEmail;
    const deliverSms = channels?.viaSms ?? viaSms;
    if (propertyIds.length === 0) return;
    if (deliverEmail && !prospectEmail.trim()) return;
    if (deliverSms && !prospectPhone.trim()) return;
    setSendBusy(true);
    try {
      if (isDemoModeActive()) {
        if (deliverEmail) {
          logDemoOutboundEmail(
            prospectEmail.trim(),
            leadInviteSubject("listing", propertyTitle, isMultiListing ? propertyIds.length : undefined),
            invitePreviewBody,
          );
        }
        showToast("Listing sent (demo).");
        setSendPreviewOpen(false);
        onClose();
        return;
      }
      const res = await fetch("/api/portal/send-lead-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "listing",
          to: prospectEmail.trim(),
          phone: prospectPhone.trim(),
          viaEmail: deliverEmail,
          viaSms: deliverSms,
          prospectName: prospectName.trim() || undefined,
          propertyId: propertyIds[0],
          propertyIds,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        showToast("Listing sent.");
        setSendPreviewOpen(false);
        onClose();
        return;
      }
      showToast(data.error ?? "Could not send listing.");
    } catch {
      showToast("Could not send listing.");
    } finally {
      setSendBusy(false);
    }
  };

  if (!open) return null;

  const listingsStep = (
    <div className="send29-fields mx-auto max-w-[620px] space-y-5">
      {properties.length === 0 ? (
        <p className="text-sm text-muted">List a property as active before sharing a listing link.</p>
      ) : multiEnabled ? (
        <div>
          <p className={FIELD_LABEL_CLASS}>Properties</p>
          <CheckboxMultiSelect
            hideLabel
            label="Properties"
            dataAttr="send-lead-property-multi"
            emptyLabel="Select properties"
            emptyMenuText="No properties"
            options={properties.map((p) => ({ value: p.id, label: p.label }))}
            selected={propertyIds}
            onChange={setPropertyIds}
          />
          <div className="mt-4">
            <p className={FIELD_LABEL_CLASS}>{isMultiListing ? "Public browse link" : "Public listing link"}</p>
            <SendListingLinkRow
              label={isMultiListing ? "Public browse link" : "Public listing link"}
              url={linkUrl}
              onCopy={() =>
                void handleCopy(linkUrl, isMultiListing ? "Browse link copied." : "Listing link copied.")
              }
              dataAttr="send30-linkrow"
            />
          </div>
        </div>
      ) : (
        <div>
          <p className={FIELD_LABEL_CLASS}>Listing</p>
          <p className="text-sm font-semibold text-foreground">{properties[0]?.label}</p>
          <div className="mt-4">
            <SendListingLinkRow
              label="Public listing link"
              url={linkUrl}
              onCopy={() => void handleCopy(linkUrl, "Listing link copied.")}
              dataAttr="send30-linkrow"
            />
          </div>
        </div>
      )}
    </div>
  );

  const recipientStep = (
    <div className={`send29-fields mx-auto max-w-[620px] space-y-5 ${PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}`}>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="send-listing-name">Name</label>
        <Input id="send-listing-name" value={prospectName} onChange={(e) => setProspectName(e.target.value)} />
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="send-listing-email">Email</label>
        <Input id="send-listing-email" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} />
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS}>Phone</label>
        <PhoneNumberField value={prospectPhone} onChange={setProspectPhone} dataAttr="send-listing-phone" />
      </div>
      <PortalMessageSendViaDropdown selected={sendVia} onChange={setSendVia} smsAvailable={smsAvailable} dataAttr="send-listing-via" />
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="send-listing-note">Note (optional)</label>
        <Input id="send-listing-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </div>
  );

  const reviewStep = (
    <div className="send29-preview mx-auto max-w-[620px] whitespace-pre-wrap text-sm leading-relaxed">
      {invitePreviewBody || "Choose listings and a recipient to preview the message."}
    </div>
  );

  const body =
    step === 0 ? listingsStep : step === 1 ? recipientStep : reviewStep;

  return (
    <>
      <ListingWizardOverlay ariaLabel="Send listing">
        <AddWorkspace
          title="Send listing"
          steps={STEPS}
          current={step}
          onJump={setStep}
          onClose={onClose}
          assistantContext="Manager is sharing a public listing link with a prospect."
          assistantScopeKey="send-listing-wizard"
          lastLabel="Preview & send"
          lastDisabled={propertyIds.length === 0}
          nextDisabled={step === 0 && propertyIds.length === 0}
          onBeforeNext={() => {
            if (step === 1) {
              if (!viaEmail && !viaSms) {
                showToast("Choose email, SMS, or both.");
                return false;
              }
              if (viaEmail && !prospectEmail.trim().includes("@")) {
                showToast("Enter a valid prospect email.");
                return false;
              }
              if (viaSms && prospectPhone.replace(/\D/g, "").length < 10) {
                showToast("Enter a valid prospect phone number for SMS.");
                return false;
              }
            }
            return true;
          }}
          onFinish={() => setSendPreviewOpen(true)}
          busy={sendBusy}
          dataAttrPrefix="send-listing-wizard"
        >
          {body}
        </AddWorkspace>
      </ListingWizardOverlay>
      <PortalNotificationPreviewModal
        open={sendPreviewOpen}
        onClose={() => setSendPreviewOpen(false)}
        title="Send listing"
        recipient={prospectEmail.trim() || "prospect"}
        recipientPhone={prospectPhone.trim() || undefined}
        subject={leadInviteSubject("listing", propertyTitle, isMultiListing ? propertyIds.length : undefined)}
        body={invitePreviewBody}
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable={smsAvailable}
        defaultViaEmail={viaEmail}
        defaultViaSms={viaSms}
        editableSubject={viaEmail}
        footerNote=""
        confirmLabel="Send listing"
        confirmBusy={sendBusy}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels) => {
          void sendInvite(channels);
        }}
        panelClassName="max-w-lg"
      />
    </>
  );
}
