"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { logDemoOutboundEmail } from "@/lib/demo-outbound-mail";
import {
  buildLeadInviteEmailBody,
  leadInviteSubject,
  buildLeadInviteSmsText,
  type LeadInviteKind,
} from "@/lib/lead-invite-email";
import {
  buildManagerApplyUrl,
  buildManagerBrowseUrl,
  buildManagerPortfolioApplyUrl,
  buildManagerListingUrl,
  buildManagerPortfolioTourUrl,
  buildManagerTourUrl,
  copyTextToClipboard,
} from "@/lib/manager-property-links";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue, propertyAllowsShortTermRental } from "@/lib/rental-application/data";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";
import {
  portalMessageChannelsFromSelection,
  PortalMessageSendViaDropdown,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
} from "@/components/portal/portal-message-compose-fields";
import type { NotificationDeliveryChannels } from "@/components/portal/portal-notification-preview-modal";

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

const APPLY_RENTAL_TYPE_OPTIONS = [
  { value: "standard", label: "Long-term lease" },
  { value: "short_term", label: "Short-term stay" },
] as const;

/** Omit `rentalType` when both products are allowed or only long-term is selected. */
function applyLinkRentalType(types: string[]): "short_term" | undefined {
  const hasStandard = types.includes("standard");
  const hasShort = types.includes("short_term");
  if (hasStandard && hasShort) return undefined;
  if (hasShort && !hasStandard) return "short_term";
  return undefined;
}

function ShareLinkCopyRow({
  label,
  url,
  copyLabel,
  onCopy,
  hint,
}: {
  label: string;
  url: string;
  copyLabel: string;
  onCopy: () => void;
  hint?: ReactNode;
}) {
  return (
    <div>
      <p className={FIELD_LABEL_CLASS}>{label}</p>
      <div className="flex items-stretch gap-2">
        <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-xl border border-border bg-accent/30 px-3 py-2 text-xs text-muted">
          <span className="truncate">{url || "Select a property to generate a link."}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-10 shrink-0 rounded-full px-3 text-xs whitespace-nowrap sm:px-4 sm:text-sm"
          disabled={!url}
          onClick={onCopy}
        >
          <span className="sm:hidden">Copy</span>
          <span className="hidden sm:inline">{copyLabel}</span>
        </Button>
      </div>
      {hint ? <div className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</div> : null}
    </div>
  );
}


export function ShareLeadLinkModal({
  open,
  onClose,
  kind,
  properties,
  preselectedPropertyId,
}: {
  open: boolean;
  onClose: () => void;
  kind: LeadInviteKind;
  properties: ManagerPropertyFilterOption[];
  preselectedPropertyId?: string;
}) {
  const { showToast } = useAppUi();
  const { isNative } = useIsNativeApp();
  const useFullPageModal = isNative === true;
  const multiEnabled = properties.length > 1;
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [roomChoice, setRoomChoice] = useState("");
  const [applyRentalTypes, setApplyRentalTypes] = useState<string[]>(["standard"]);
  const [prospectName, setProspectName] = useState("");
  const [prospectEmail, setProspectEmail] = useState("");
  const [prospectPhone, setProspectPhone] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [note, setNote] = useState("");
  const [sendPreviewOpen, setSendPreviewOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const wasOpenRef = useRef(false);

  // Reset only when the modal opens — not when `properties` re-hydrates from a
  // background portfolio sync while the user is picking listings (that used to
  // snap the selection back to properties[0], e.g. 4709A).
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;

    const initialId =
      preselectedPropertyId && properties.some((p) => p.id === preselectedPropertyId)
        ? preselectedPropertyId
        : properties[0]?.id ?? "";
    setPropertyIds(initialId ? [initialId] : []);
    setRoomChoice("");
    setApplyRentalTypes(["standard"]);
    setProspectName("");
    setProspectEmail("");
    setProspectPhone("");
    setSendVia(["email"]);
    setNote("");
    setSendPreviewOpen(false);
    setSendBusy(false);
  }, [open, preselectedPropertyId, properties]);

  useEffect(() => {
    if (!open) return;
    const valid = new Set(properties.map((p) => p.id));
    setPropertyIds((prev) => {
      const next = prev.filter((id) => valid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [open, properties]);

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

  const { viaEmail, viaSms } = portalMessageChannelsFromSelection(sendVia);

  const singlePropertyId = propertyIds.length === 1 ? propertyIds[0] : "";
  const isMultiProperty = propertyIds.length > 1;
  const isMultiListing = kind === "listing" && isMultiProperty;
  const isMultiApply = kind === "apply" && isMultiProperty;
  const isPortfolioTour = kind === "tour" && isMultiProperty;

  const propertyTitle = useMemo(() => {
    if (isMultiProperty) {
      return kind === "tour" ? `${propertyIds.length} properties` : `${propertyIds.length} homes`;
    }
    if (!singlePropertyId) return "";
    return properties.find((p) => p.id === singlePropertyId)?.label ?? singlePropertyId;
  }, [properties, singlePropertyId, isMultiProperty, propertyIds.length, kind]);

  const portfolioTourUrl = useMemo(() => {
    if (!isPortfolioTour || typeof window === "undefined") return "";
    return buildManagerPortfolioTourUrl(window.location.origin, propertyIds);
  }, [isPortfolioTour, propertyIds]);

  const individualTourLinks = useMemo(() => {
    if (kind !== "tour" || typeof window === "undefined") return [];
    const origin = window.location.origin;
    const selected = new Set(propertyIds);
    return properties
      .filter((property) => selected.has(property.id))
      .map((property) => ({
        id: property.id,
        label: property.label,
        url: buildManagerTourUrl(origin, property.id),
      }));
  }, [kind, properties, propertyIds]);

  const roomOptions = useMemo(() => {
    if (kind !== "apply" || !singlePropertyId) return [];
    return getRoomOptionsForProperty(singlePropertyId, { includeUnavailable: true }).filter((o) => o.value);
  }, [kind, singlePropertyId]);

  const shortTermApplyAvailable = useMemo(() => {
    if (kind !== "apply" || propertyIds.length === 0) return false;
    return propertyIds.every((id) => propertyAllowsShortTermRental(id));
  }, [kind, propertyIds]);

  const effectiveApplyRentalTypes = useMemo(
    () =>
      shortTermApplyAvailable
        ? applyRentalTypes
        : applyRentalTypes.filter((type) => type !== "short_term"),
    [applyRentalTypes, shortTermApplyAvailable],
  );

  useEffect(() => {
    if (!shortTermApplyAvailable) {
      setApplyRentalTypes((prev) => {
        const next = prev.filter((type) => type !== "short_term");
        return next.length > 0 ? next : ["standard"];
      });
    }
  }, [shortTermApplyAvailable]);

  const linkUrl = useMemo(() => {
    if (propertyIds.length === 0 || typeof window === "undefined") return "";
    const origin = window.location.origin;
    if (isPortfolioTour) return portfolioTourUrl;
    if (isMultiListing) return buildManagerBrowseUrl(origin, propertyIds);
    if (isMultiApply) {
      return buildManagerPortfolioApplyUrl(origin, propertyIds, {
        rentalType: applyLinkRentalType(effectiveApplyRentalTypes),
      });
    }
    if (!singlePropertyId) return "";
    if (kind === "tour") return buildManagerTourUrl(origin, singlePropertyId);
    if (kind === "listing") return buildManagerListingUrl(origin, singlePropertyId);
    const { listingRoomId } = roomChoice ? parseRoomChoiceValue(roomChoice) : { listingRoomId: undefined };
    const roomName = roomChoice ? roomOptions.find((o) => o.value === roomChoice)?.label : undefined;
    return buildManagerApplyUrl(origin, {
      propertyId: singlePropertyId,
      listingRoomId: listingRoomId || undefined,
      roomName: roomName || undefined,
      rentalType: applyLinkRentalType(effectiveApplyRentalTypes),
    });
  }, [kind, propertyIds, singlePropertyId, isMultiListing, isMultiApply, isPortfolioTour, portfolioTourUrl, roomChoice, roomOptions, effectiveApplyRentalTypes]);

  const applyAllowsBothRentalTypes =
    kind === "apply" &&
    applyRentalTypes.includes("standard") &&
    applyRentalTypes.includes("short_term");

  const listingSummary = useMemo(() => {
    if (kind !== "listing" || isMultiListing || !singlePropertyId) return null;
    const property = getPropertyById(singlePropertyId);
    if (!property) return null;
    return buildListingShareSummary(property);
  }, [kind, singlePropertyId, isMultiListing]);

  const invitePreviewBody = useMemo(() => {
    if (!linkUrl) return "";
    if (isMultiProperty) {
      return buildLeadInviteEmailBody({
        kind,
        prospectName: prospectName.trim() || undefined,
        propertyTitle,
        linkUrl,
        listingCount: isMultiListing || isMultiApply ? propertyIds.length : undefined,
        tourCount: isPortfolioTour ? propertyIds.length : undefined,
        managerNote: note.trim() || undefined,
      });
    }
    return buildLeadInviteEmailBody({
      kind,
      prospectName: prospectName.trim() || undefined,
      propertyTitle,
      linkUrl: kind === "listing" ? buildManagerApplyUrl(typeof window !== "undefined" ? window.location.origin : "", {
        propertyId: singlePropertyId,
      }) : linkUrl,
      listingPageUrl: kind === "listing" ? linkUrl : undefined,
      tourUrl:
        kind === "listing" && singlePropertyId && typeof window !== "undefined"
          ? buildManagerTourUrl(window.location.origin, singlePropertyId)
          : undefined,
      listingSummary: listingSummary ?? undefined,
      managerNote: note.trim() || undefined,
    });
  }, [kind, prospectName, propertyTitle, linkUrl, singlePropertyId, isMultiProperty, isMultiListing, isPortfolioTour, isMultiApply, propertyIds.length, roomChoice, roomOptions, listingSummary, note]);

  const inviteSmsBody = useMemo(() => {
    if (!linkUrl) return "";
    return buildLeadInviteSmsText({
      kind,
      prospectName: prospectName.trim() || undefined,
      propertyTitle,
      linkUrl,
      listingCount: isMultiListing || isMultiApply ? propertyIds.length : undefined,
      tourCount: isPortfolioTour ? propertyIds.length : undefined,
      managerNote: note.trim() || undefined,
    });
  }, [
    kind,
    prospectName,
    propertyTitle,
    linkUrl,
    isMultiListing,
    isMultiApply,
    isPortfolioTour,
    propertyIds.length,
    note,
  ]);

  const previewBody = viaSms && !viaEmail ? inviteSmsBody : invitePreviewBody;

  const sendListingRoomParams = useMemo(() => {
    if (kind === "listing" || isMultiListing || isMultiApply) {
      return { listingRoomId: undefined, roomName: undefined };
    }
    if (!roomChoice) return { listingRoomId: undefined, roomName: undefined };
    const { listingRoomId } = parseRoomChoiceValue(roomChoice);
    return {
      listingRoomId: listingRoomId || undefined,
      roomName: roomOptions.find((o) => o.value === roomChoice)?.label,
    };
  }, [kind, isMultiListing, isMultiApply, roomChoice, roomOptions]);

  const handleCopy = async (text: string, successMessage: string) => {
    if (!text) {
      showToast("Select a property first.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? successMessage : "Could not copy link.");
  };

  const openSendPreview = () => {
    if (propertyIds.length === 0) {
      showToast("Select a property first.");
      return;
    }
    if (!viaEmail && !viaSms) {
      showToast("Choose email, SMS, or both.");
      return;
    }
    if (viaEmail && !prospectEmail.trim().includes("@")) {
      showToast("Enter a valid prospect email.");
      return;
    }
    if (viaSms && prospectPhone.replace(/\D/g, "").length < 10) {
      showToast("Enter a valid prospect phone number for SMS.");
      return;
    }
    setSendPreviewOpen(true);
  };

  const sendInvite = async (channels?: NotificationDeliveryChannels) => {
    const deliverEmail = channels?.viaEmail ?? viaEmail;
    const deliverSms = channels?.viaSms ?? viaSms;
    if (propertyIds.length === 0) return;
    if (deliverEmail && !prospectEmail.trim()) return;
    if (deliverSms && !prospectPhone.trim()) return;
    const { listingRoomId, roomName } = sendListingRoomParams;
    setSendBusy(true);
    try {
      if (isDemoModeActive()) {
        if (deliverEmail) {
          logDemoOutboundEmail(
            prospectEmail.trim(),
            leadInviteSubject(kind, propertyTitle, isMultiProperty ? propertyIds.length : undefined),
            invitePreviewBody,
          );
        }
        const channelLabel =
          deliverEmail && deliverSms ? "Email and SMS sent" : deliverSms ? "SMS sent" : "Listing sent";
        showToast(`${channelLabel} (demo).`);
        setSendPreviewOpen(false);
        onClose();
        return;
      }
      const res = await fetch("/api/portal/send-lead-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          to: prospectEmail.trim(),
          phone: prospectPhone.trim(),
          viaEmail: deliverEmail,
          viaSms: deliverSms,
          prospectName: prospectName.trim() || undefined,
          propertyId: propertyIds[0],
          propertyIds,
          listingRoomId: listingRoomId || undefined,
          roomName: roomName || undefined,
          note: note.trim() || undefined,
          rentalType: kind === "apply" ? applyLinkRentalType(effectiveApplyRentalTypes) : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (data.ok) {
        const channelLabel =
          deliverEmail && deliverSms ? "Email and SMS sent" : deliverSms ? "SMS sent" : kind === "listing" ? "Listing sent" : "Invite sent";
        showToast(`${channelLabel}.`);
        setSendPreviewOpen(false);
        onClose();
        return;
      }
      if (data.mailtoHref) {
        window.location.href = data.mailtoHref;
        showToast(data.error ?? "Opened your email app.");
        setSendPreviewOpen(false);
        return;
      }
      showToast(data.error ?? "Could not send invite.");
    } catch {
      showToast("Could not send invite.");
    } finally {
      setSendBusy(false);
    }
  };

  const title = kind === "listing" ? "Send listing" : kind === "apply" ? "Send application" : "Send tour link";

  const actionFooter =
    properties.length > 0 ? (
      <ModalFooter>
        <Button type="button" variant="primary" className="rounded-full" disabled={propertyIds.length === 0} onClick={openSendPreview}>
          Preview & send
        </Button>
      </ModalFooter>
    ) : undefined;

  return (
    <>
      <Modal
        open={open}
        title={title}
        onClose={onClose}
        dense
        panelClassName="max-w-lg"
        fullPage={useFullPageModal}
        fullScreenMobile={useFullPageModal}
        footer={actionFooter}
      >
        <div className="max-h-[min(60vh,28rem)] space-y-3 overflow-y-auto pr-0.5 [scrollbar-width:thin]">
          {properties.length === 0 ? (
            <p className="text-sm text-muted">
              No active properties yet. List a property as active before sharing apply or tour links.
            </p>
          ) : (
            <>
              {multiEnabled ? (
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label htmlFor="share-lead-property-multi" className={FIELD_LABEL_CLASS}>
                      Properties
                    </label>
                    <div className="flex items-center gap-3 text-[11px] font-semibold">
                      <button
                        type="button"
                        className="text-primary hover:opacity-90 disabled:opacity-40"
                        data-attr="share-lead-select-all"
                        disabled={propertyIds.length === properties.length}
                        onClick={() => {
                          setPropertyIds(properties.map((p) => p.id));
                          setRoomChoice("");
                        }}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="text-muted hover:text-foreground disabled:opacity-40"
                        data-attr="share-lead-clear"
                        disabled={propertyIds.length === 0}
                        onClick={() => {
                          setPropertyIds([]);
                          setRoomChoice("");
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <CheckboxMultiSelect
                    hideLabel
                    label="Properties"
                    dataAttr="share-lead-property-multi"
                    emptyLabel="Select properties"
                    emptyMenuText="No properties"
                    options={properties.map((p) => ({ value: p.id, label: p.label }))}
                    selected={propertyIds}
                    onChange={(next) => {
                      setPropertyIds(next);
                      setRoomChoice("");
                    }}
                  />
                </div>
              ) : (
                <div
                  className={
                    kind === "apply" && roomOptions.length > 0 ? "grid gap-3 sm:grid-cols-2" : undefined
                  }
                >
                  <div>
                    <label htmlFor="share-lead-property" className={FIELD_LABEL_CLASS}>
                      Property
                    </label>
                    <Select
                      id="share-lead-property"
                      value={singlePropertyId}
                      onChange={(e) => {
                        const next = e.target.value;
                        setPropertyIds(next ? [next] : []);
                        setRoomChoice("");
                      }}
                    >
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {kind === "apply" && roomOptions.length > 0 ? (
                    <div>
                      <label htmlFor="share-lead-room" className={FIELD_LABEL_CLASS}>
                        Room (optional)
                      </label>
                      <Select id="share-lead-room" value={roomChoice} onChange={(e) => setRoomChoice(e.target.value)}>
                        <option value="">Any room</option>
                        {roomOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : null}
                </div>
              )}

              {kind === "apply" && multiEnabled && shortTermApplyAvailable ? (
                <CheckboxMultiSelect
                  label="Application"
                  dataAttr="share-lead-application-multi"
                  emptyLabel="Select application type"
                  emptyMenuText="No options"
                  options={[...APPLY_RENTAL_TYPE_OPTIONS]}
                  selected={applyRentalTypes}
                  onChange={(next) => {
                    setApplyRentalTypes(next.length > 0 ? next : ["standard"]);
                  }}
                />
              ) : null}

              {kind === "apply" && !multiEnabled && shortTermApplyAvailable ? (
                <div>
                  <label htmlFor="share-lead-application-type" className={FIELD_LABEL_CLASS}>
                    Application
                  </label>
                  <Select
                    id="share-lead-application-type"
                    value={applyRentalTypes[0] === "short_term" ? "short_term" : "standard"}
                    onChange={(e) =>
                      setApplyRentalTypes([e.target.value === "short_term" ? "short_term" : "standard"])
                    }
                  >
                    <option value="standard">Long-term lease</option>
                    <option value="short_term">Short-term stay</option>
                  </Select>
                </div>
              ) : null}

              {kind === "listing" ? (
                <ShareLinkCopyRow
                  label={isMultiListing ? "Public browse link" : "Public listing link"}
                  url={linkUrl}
                  copyLabel={isMultiListing ? "Copy browse link" : "Copy listing link"}
                  onCopy={() =>
                    void handleCopy(linkUrl, isMultiListing ? "Browse link copied." : "Listing link copied.")
                  }
                  hint={
                    isMultiListing
                      ? `Opens the browse page filtered to the ${propertyIds.length} homes you selected.`
                      : undefined
                  }
                />
              ) : null}

              {kind === "tour" ? (
                <div className="space-y-4">
                  {isPortfolioTour ? (
                    <ShareLinkCopyRow
                      label="Generic tour link"
                      url={portfolioTourUrl}
                      copyLabel="Copy generic tour link"
                      onCopy={() => void handleCopy(portfolioTourUrl, "Generic tour link copied.")}
                      hint="Prospects pick which property to tour before choosing a time."
                    />
                  ) : null}

                  {isPortfolioTour ? (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Property tour links</p>
                      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                        {individualTourLinks.map((entry) => (
                          <div key={entry.id} className="rounded-xl border border-border bg-accent/20 px-3 py-2.5">
                            <p className="mb-2 text-sm font-semibold text-foreground">{entry.label}</p>
                            <div className="flex items-stretch gap-2">
                              <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted">
                                <span className="truncate">{entry.url}</span>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                className="h-10 shrink-0 rounded-full px-3 text-xs whitespace-nowrap sm:px-4 sm:text-sm"
                                onClick={() => handleCopy(entry.url, "Tour link copied.")}
                              >
                                Copy link
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <ShareLinkCopyRow
                      label="Public tour link"
                      url={linkUrl}
                      copyLabel="Copy tour link"
                      onCopy={() => void handleCopy(linkUrl, "Tour link copied.")}
                    />
                  )}
                </div>
              ) : null}

              {kind === "apply" ? (
                <ShareLinkCopyRow
                  label="Public application link"
                  url={linkUrl}
                  copyLabel="Copy application link"
                  onCopy={() =>
                    void handleCopy(linkUrl, "Application link copied.")
                  }
                  hint={
                    isMultiApply
                      ? applyAllowsBothRentalTypes
                        ? `Opens the application flow so the prospect can choose one of the ${propertyIds.length} homes you selected, then long-term or short-term.`
                        : `Opens the application flow so the prospect can choose one of the ${propertyIds.length} homes you selected.`
                      : applyAllowsBothRentalTypes
                        ? "Applicants choose long-term or short-term in the application after signing in or continuing as a guest."
                        : "Applicants create a resident account first, then complete the application in their portal."
                  }
                />
              ) : null}

              <div className="border-t border-border pt-3">
                <p className="text-sm font-semibold text-foreground">Send to prospect</p>
                <p className="mt-1 text-xs text-muted">
                  Choose email and/or SMS. Messages send from PropLane when delivery is configured.
                </p>
                <div className="mt-3 space-y-3">
                  <PortalMessageSendViaDropdown
                    selected={sendVia}
                    onChange={setSendVia}
                    smsAvailable={smsAvailable}
                    footerNote={
                      smsAvailable
                        ? "SMS uses your PropLane work number."
                        : "Add a work number under Communication → SMS to text prospects."
                    }
                    dataAttr="share-lead-send-via"
                  />
                  <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
                    <div>
                      <label htmlFor="share-lead-name" className={FIELD_LABEL_CLASS}>
                        Name (optional)
                      </label>
                      <Input
                        id="share-lead-name"
                        value={prospectName}
                        onChange={(e) => setProspectName(e.target.value)}
                        placeholder="Prospect name"
                      />
                    </div>
                    {viaEmail ? (
                      <div>
                        <label htmlFor="share-lead-email" className={FIELD_LABEL_CLASS}>
                          Email
                        </label>
                        <Input
                          id="share-lead-email"
                          type="email"
                          value={prospectEmail}
                          onChange={(e) => setProspectEmail(e.target.value)}
                          placeholder="prospect@example.com"
                        />
                      </div>
                    ) : viaSms ? (
                      <div>
                        <label htmlFor="share-lead-phone" className={FIELD_LABEL_CLASS}>
                          Phone
                        </label>
                        <Input
                          id="share-lead-phone"
                          type="tel"
                          value={prospectPhone}
                          onChange={(e) => setProspectPhone(e.target.value)}
                          placeholder="(555) 555-5555"
                        />
                      </div>
                    ) : null}
                  </div>
                  {viaEmail && viaSms ? (
                    <div>
                      <label htmlFor="share-lead-phone" className={FIELD_LABEL_CLASS}>
                        Phone (SMS)
                      </label>
                      <Input
                        id="share-lead-phone"
                        type="tel"
                        value={prospectPhone}
                        onChange={(e) => setProspectPhone(e.target.value)}
                        placeholder="(555) 555-5555"
                      />
                    </div>
                  ) : null}
                  <div>
                    <label htmlFor="share-lead-note" className={FIELD_LABEL_CLASS}>
                      Note (optional)
                    </label>
                    <textarea
                      id="share-lead-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
                      placeholder="Add context for the prospect…"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={sendPreviewOpen}
        title={kind === "listing" ? "Send listing" : kind === "apply" ? "Send application" : "Send tour link"}
        onClose={() => setSendPreviewOpen(false)}
        recipient={prospectEmail.trim() || "prospect"}
        recipientPhone={prospectPhone.trim() || undefined}
        subject={leadInviteSubject(kind, propertyTitle, isMultiProperty ? propertyIds.length : undefined)}
        body={previewBody}
        intro="Review the message before sending."
        showSkipMessage={false}
        showChannelPicker
        showSchedule={false}
        emailAvailable
        smsAvailable={smsAvailable}
        defaultViaEmail={viaEmail}
        defaultViaSms={viaSms}
        editableSubject={viaEmail}
        footerNote="Sent via PropLane when email and SMS delivery are configured."
        confirmLabel={kind === "listing" ? "Send listing" : kind === "apply" ? "Send application" : "Send tour link"}
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
