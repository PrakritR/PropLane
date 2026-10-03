"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { WizardShell } from "@/components/ui/wizard-shell";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Copy, X, RotateCcw } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";

import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { logDemoOutboundEmail } from "@/lib/demo-outbound-mail";
import {
  buildLeadInviteEmailBody,
  listingShareButtonLabel,
  leadInviteSubject,
  buildLeadInviteSmsText,
  type LeadInviteKind,
} from "@/lib/lead-invite-email";
import {
  buildManagerApplyUrl,
  buildManagerBrowseUrl,
  buildManagerPortfolioApplyUrl,
  buildManagerListingUrl,
  buildManagerLeaseSignUrl,
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
} from "@/components/portal/portal-message-compose-fields";
import type { NotificationDeliveryChannels } from "@/components/portal/portal-notification-preview-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import { partitionTourAvailabilityStoredKeys } from "@/lib/tour-slot-math";
import Link from "next/link";

import { DEFAULT_LISTING_SHARED_INTRO, LISTING_SHARED_TEMPLATE_KEY, renderListingSharedIntro } from "@/lib/listing-shared-template";
import { normalizeAutomatedMessageSettings } from "@/lib/automated-messages-settings";

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

/** True when the manager has not painted any open tour windows for this property. */
function propertyHasPublishedTourSlots(managerUserId: string, propertyId: string): boolean {
  if (!managerUserId.trim() || !propertyId.trim()) return false;
  const key = managerPropertyAvailabilityStorageKey(managerUserId, propertyId);
  const stored = [...readAvailabilityDateSetForStorageKey(key)];
  return partitionTourAvailabilityStoredKeys(stored).publishedSlots.length > 0;
}

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
        <PortalIconAction icon={Copy} label={copyLabel} disabled={!url} onClick={onCopy} />
      </div>
      {hint ? <div className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</div> : null}
    </div>
  );
}


function ListingIntroEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Keep the native selection while typing; React must not replace this text node.
    if (ref.current && ref.current.textContent !== value) ref.current.textContent = value;
  }, [value]);
  return <p ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-label="Email intro"
    onInput={(event) => onChange(event.currentTarget.textContent || "")}
    className="min-w-0 flex-1 rounded-lg p-2 outline-none focus:ring-2 focus:ring-primary" />;
}

export function ShareLeadLinkModal({
  open,
  onClose,
  kind,
  properties,
  preselectedPropertyId,
  preselectedPropertyIds,
}: {
  open: boolean;
  onClose: () => void;
  kind: LeadInviteKind;
  properties: ManagerPropertyFilterOption[];
  preselectedPropertyId?: string;
  /**
   * Several properties to open with, for a bulk share from the Properties list.
   * `listing` and `apply` are already multi-select inside the modal — this just
   * lets a caller seed the whole selection instead of one row. Unknown ids are
   * dropped rather than shown, matching the singular prop's behaviour. Takes
   * precedence over `preselectedPropertyId` when both are supplied.
   */
  preselectedPropertyIds?: string[];
}) {
  const { showToast } = useAppUi();
  const { userId: managerUserId } = useManagerUserId();
  const multiEnabled = properties.length > 1;
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [roomChoice, setRoomChoice] = useState("");
  const [applyRentalTypes, setApplyRentalTypes] = useState<string[]>(["standard"]);
  const [prospectName, setProspectName] = useState("");
  const [prospectEmail, setProspectEmail] = useState("");
  const [prospectPhone, setProspectPhone] = useState("");
  const [sendVia, setSendVia] = useState<string[]>(["email"]);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [listingTemplate, setListingTemplate] = useState(DEFAULT_LISTING_SHARED_INTRO);
  const [intro, setIntro] = useState<string | null>(null);
  const [sender, setSender] = useState<{ from: string; name: string; email: string; origin: string; workNumber?: string | null } | null>(null);
  const [workNumber, setWorkNumber] = useState("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState(0);
  const [sendBusy, setSendBusy] = useState(false);
  const wasOpenRef = useRef(false);
  const linkOrigin = sender?.origin || (typeof window !== "undefined" ? window.location.origin : "");

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
    setRoomChoice("");
    setApplyRentalTypes(["standard"]);
    setProspectName("");
    setProspectEmail("");
    setProspectPhone("");
    setSendVia(["email"]);
    setNote("");
    setIntro(null);
    setStep(0);
    setSendBusy(false);
  }, [open, preselectedPropertyId, preselectedPropertyIds, properties]);

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
        setWorkNumber(payload.workNumber?.trim() || "");
      })
      .catch(() => {
        if (active) setSmsAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch("/api/portal/send-lead-invite", { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      if (active) setSender(data);
    }).catch(() => { if (active) showToast("Could not load sender identity."); });
    return () => { active = false; };
  }, [open, showToast]);

  const propertiesMissingTourAvailability = useMemo(() => {
    if (kind !== "tour" || !managerUserId || propertyIds.length === 0) return [];
    return properties
      .filter((property) => propertyIds.includes(property.id))
      .filter((property) => !propertyHasPublishedTourSlots(managerUserId, property.id));
  }, [kind, managerUserId, properties, propertyIds]);

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
    return buildManagerPortfolioTourUrl(linkOrigin, propertyIds);
  }, [isPortfolioTour, propertyIds, linkOrigin]);

  const individualTourLinks = useMemo(() => {
    if (kind !== "tour" || typeof window === "undefined") return [];
    const origin = linkOrigin;
    const selected = new Set(propertyIds);
    return properties
      .filter((property) => selected.has(property.id))
      .map((property) => ({
        id: property.id,
        label: property.label,
        url: buildManagerTourUrl(origin, property.id),
      }));
  }, [kind, properties, propertyIds, linkOrigin]);

  const roomOptions = useMemo(() => {
    if ((kind !== "apply" && kind !== "lease") || !singlePropertyId) return [];
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

  // Lease invites are always one property (create-account → /resident/lease).
  useEffect(() => {
    if (!open || kind !== "lease") return;
    if (propertyIds.length <= 1) return;
    setPropertyIds((prev) => (prev[0] ? [prev[0]] : []));
    setRoomChoice("");
  }, [open, kind, propertyIds.length]);

  const linkUrl = useMemo(() => {
    if (propertyIds.length === 0 || typeof window === "undefined") return "";
    const origin = linkOrigin;
    if (kind === "lease") {
      if (!singlePropertyId) return "";
      return buildManagerLeaseSignUrl(origin, {
        propertyId: singlePropertyId,
        email: prospectEmail.trim() || undefined,
        fullName: prospectName.trim() || undefined,
        phone: prospectPhone.trim() || undefined,
      });
    }
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
  }, [
    kind,
    propertyIds,
    singlePropertyId,
    isMultiListing,
    isMultiApply,
    isPortfolioTour,
    portfolioTourUrl,
    roomChoice,
    roomOptions,
    effectiveApplyRentalTypes,
    prospectEmail,
    prospectName,
    prospectPhone,
    linkOrigin,
  ]);


  const templatePropertyId = propertyIds[0] || "";
  useEffect(() => {
    if (!open || kind !== "listing") return;
    let active = true;
    setListingTemplate(DEFAULT_LISTING_SHARED_INTRO);
    const query = new URLSearchParams();
    if (templatePropertyId) query.set("propertyId", templatePropertyId);
    void fetch(`/api/portal/automated-messages?${query}`, { credentials: "include" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load listing template.");
      if (active) setListingTemplate(normalizeAutomatedMessageSettings(data.settings)[LISTING_SHARED_TEMPLATE_KEY]?.template?.body || DEFAULT_LISTING_SHARED_INTRO);
    }).catch(() => { if (active) showToast("Could not load listing template. Using the default wording."); });
    return () => { active = false; };
  }, [open, kind, templatePropertyId, showToast]);

  const listingIntro = intro ?? renderListingSharedIntro(listingTemplate, { count: propertyIds.length, property: properties.filter((property) => propertyIds.includes(property.id)).map((property) => property.label).join(", "), name: prospectName });
  const listingShare = useMemo(() => ({ intro: listingIntro, signature: sender ? [sender.name, ...(sender.workNumber ? [sender.workNumber] : []), sender.email] : undefined, listings: propertyIds.flatMap((id) => { const property = getPropertyById(id); return property ? [buildListingShareSummary(property)] : []; }) }), [listingIntro, propertyIds, sender]);

  const listingSummary = useMemo(() => {
    if (kind !== "listing" || isMultiListing || !singlePropertyId) return null;
    const property = getPropertyById(singlePropertyId);
    if (!property) return null;
    return buildListingShareSummary(property);
  }, [kind, singlePropertyId, isMultiListing]);

  const invitePreviewBody = useMemo(() => {
    if (!linkUrl) return "";
    if (kind === "listing") return buildLeadInviteEmailBody({ kind, prospectName, propertyTitle, linkUrl, listingShare });
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
      linkUrl,
      listingPageUrl: undefined,
      tourUrl: undefined,
      listingSummary: listingSummary ?? undefined,
      managerNote: note.trim() || undefined,
    });
  }, [kind, prospectName, propertyTitle, linkUrl, singlePropertyId, isMultiProperty, isMultiListing, isPortfolioTour, isMultiApply, propertyIds.length, listingSummary, note, listingShare, linkOrigin]);

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
    if (kind === "listing" || kind === "lease" || isMultiListing || isMultiApply) {
      return { listingRoomId: undefined, roomName: undefined };
    }
    if (!roomChoice) return { listingRoomId: undefined, roomName: undefined };
    const { listingRoomId } = parseRoomChoiceValue(roomChoice);
    return {
      listingRoomId: listingRoomId || undefined,
      roomName: roomOptions.find((o) => o.value === roomChoice)?.label,
    };
  }, [kind, isMultiListing, isMultiApply, roomChoice, roomOptions]);

  const inviteTitle =
    kind === "listing"
      ? "Send listing"
      : kind === "apply"
        ? "Send application"
        : kind === "lease"
          ? "Send lease to sign"
          : "Send tour link";

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
    if (viaEmail && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(prospectEmail.trim())) {
      showToast("Enter a valid prospect email.");
      return;
    }
    if (viaSms && !smsAvailable) {
      showToast("A work number is required to send text messages.");
      return;
    }
    if (viaSms && prospectPhone.replace(/\D/g, "").length < 10) {
      showToast("Enter a valid prospect phone number for SMS.");
      return;
    }
    setStep(2);
  };

  const sendInvite = async (channels?: NotificationDeliveryChannels) => {
    const deliverEmail = channels?.viaEmail ?? viaEmail;
    const deliverSms = channels?.viaSms ?? viaSms;
    if (propertyIds.length === 0) return;
    if (deliverEmail && !prospectEmail.trim()) return;
    if (deliverSms && !prospectPhone.trim()) return;
    if (kind === "listing" && listingIntro.length > 4000) { showToast("Keep the email intro under 4,000 characters."); return; }
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
        setStep(0);
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
          listingIntro: kind === "listing" ? listingIntro : undefined,
          rentalType: kind === "apply" ? applyLinkRentalType(effectiveApplyRentalTypes) : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (data.ok) {
        const channelLabel =
          deliverEmail && deliverSms ? "Email and SMS sent" : deliverSms ? "SMS sent" : kind === "listing" ? "Listing sent" : "Invite sent";
        showToast(`${channelLabel}.`);
        setStep(0);
        onClose();
        return;
      }
      if (data.mailtoHref) {
        window.location.href = data.mailtoHref;
        showToast(data.error ?? "Opened your email app.");
        setStep(0);
        return;
      }
      showToast(data.error ?? "Could not send invite.");
    } catch {
      showToast("Could not send invite.");
    } finally {
      setSendBusy(false);
    }
  };

  if (!open) return null;
  const subject = leadInviteSubject(kind, propertyTitle, isMultiProperty ? propertyIds.length : undefined);
  const steps = [{ id: "home", label: "Home" }, { id: "recipient", label: "Recipient" }, { id: "review", label: "Review" }];
  const rowClass = "grid gap-3 border-b border-border px-4 py-4 last:border-0 sm:grid-cols-[140px_1fr] sm:items-center";
  const individualLinks = properties.filter((property) => propertyIds.includes(property.id)).map((property) => ({
    id: property.id, label: property.label,
    url: propertyIds.length === 1 ? linkUrl : kind === "listing" ? buildManagerListingUrl(linkOrigin, property.id)
      : kind === "apply" ? buildManagerApplyUrl(linkOrigin, { propertyId: property.id, rentalType: applyLinkRentalType(effectiveApplyRentalTypes) })
      : kind === "tour" ? individualTourLinks.find((entry) => entry.id === property.id)?.url ?? "" : linkUrl,
  }));
  return (
    <ListingWizardOverlay ariaLabel={inviteTitle}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card" data-attr="share-lead-wizard">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">{inviteTitle}</h2>
          <PortalIconAction icon={X} label="Close" onClick={onClose} disabled={sendBusy} />
        </header>
        <WizardShell steps={steps} currentStepIndex={step} footer={
          <div className="flex flex-1 items-center justify-between gap-4">
            <Button variant="ghost" disabled={step === 0 || sendBusy} onClick={() => setStep((value) => value - 1)}>Back</Button>
            <span className="text-sm text-muted">Step {step + 1} of 3</span>
            <Button disabled={!propertyIds.length || sendBusy || (step === 2 && !sender)} onClick={() => {
              if (step === 0) { setStep(1); return; }
              if (step === 1) { openSendPreview(); return; }
              return sendInvite();
            }}>{step === 2 ? "Send" : "Continue"}</Button>
          </div>
        }>
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
            <div className="min-w-0 space-y-6">
              <h3 className="text-xl font-semibold">{steps[step].label}</h3>
              {step === 0 ? <>
                {properties.length === 0 ? <p role="status">No active properties to share.</p> : <>
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <div className={rowClass}><span>Properties</span>{multiEnabled && kind !== "lease" ?
                      <CheckboxMultiSelect hideLabel label="Properties" dataAttr="share-lead-property-multi" emptyLabel="Select properties" emptyMenuText="No properties" options={properties.map((p) => ({ value: p.id, label: p.label }))} selected={propertyIds} onChange={(next) => { setPropertyIds(next); setRoomChoice(""); }} /> :
                      <Select aria-label="Property" value={singlePropertyId} onChange={(e) => { setPropertyIds(e.target.value ? [e.target.value] : []); setRoomChoice(""); }}>{properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>}
                    </div>
                    {kind === "apply" && shortTermApplyAvailable ? <div className={rowClass}><label htmlFor="share-lead-application-type">Application</label><Select id="share-lead-application-type" value={applyRentalTypes[0]} onChange={(e) => setApplyRentalTypes([e.target.value])}>{APPLY_RENTAL_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div> : null}
                    {singlePropertyId && roomOptions.length > 0 ? <div className={rowClass}><label htmlFor="share-lead-room">Room</label><Select id="share-lead-room" value={roomChoice} onChange={(e) => setRoomChoice(e.target.value)}><option value="">Any room</option>{roomOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div> : null}
                  </div>
                  {propertiesMissingTourAvailability.length > 0 ? <div role="status" data-attr="share-lead-tour-availability-warning" className="rounded-xl border border-amber-200 p-4 text-sm">
                    <p>{propertiesMissingTourAvailability.map((property) => property.label).join(", ")} has no open tour windows yet.</p>
                    <Link href="/portal/calendar" data-attr="share-lead-tour-availability-calendar-link">Open Calendar to add availability</Link>
                  </div> : null}
                  {individualLinks.map((entry) => <ShareLinkCopyRow key={entry.id} label={entry.label} url={entry.url} copyLabel={`Copy link for ${entry.label}`} onCopy={() => void handleCopy(entry.url, "Link copied.")} />)}
                  {isMultiProperty ? <ShareLinkCopyRow label="Combined link" url={linkUrl} copyLabel="Copy combined link" onCopy={() => void handleCopy(linkUrl, "Link copied.")} /> : null}
                </>}
              </> : step === 1 ? <div className="overflow-hidden rounded-2xl border border-border">
                <div className={rowClass}><span>Send via</span><CheckboxMultiSelect hideLabel label="Send via" dataAttr="share-lead-send-via" emptyLabel="Select channels" emptyMenuText="No channels" options={[{ value: "email", label: "Email" }, ...(smsAvailable ? [{ value: "sms", label: "Text message" }] : [])]} selected={sendVia} onChange={setSendVia} /></div>
                <div className={rowClass}><label htmlFor="share-lead-name">Name</label><Input id="share-lead-name" value={prospectName} onChange={(e) => setProspectName(e.target.value)} placeholder="Prospect name" /></div>
                {viaEmail ? <div className={rowClass}><label htmlFor="share-lead-email">Email</label><Input id="share-lead-email" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} placeholder="prospect@example.com" /></div> : null}
                {viaSms ? <div className={rowClass}><label htmlFor="share-lead-phone">Phone number</label><PhoneNumberField id="share-lead-phone" value={prospectPhone} onChange={setProspectPhone} dataAttr="share-lead-phone" /></div> : null}
              </div> : <div className="space-y-6">
                {viaEmail ? <section className="overflow-hidden rounded-2xl border border-border" aria-label="Email preview">
                  <div className="space-y-2 border-b border-border p-4 text-sm"><div>From: {sender?.from || "Loading…"}</div><div>To: {prospectName ? `${prospectName} · ` : ""}{prospectEmail}</div><div>Subject: {subject}</div></div>
                  {kind === "listing" ? <div className="bg-accent/20 p-4"><div className="rounded-xl border border-border bg-card p-6 text-sm leading-relaxed">
                    <p className="mb-3">{prospectName.trim() ? `Hi ${prospectName.trim()},` : "Hi there,"}</p>
                    <div className="mb-4 flex items-start gap-2"><ListingIntroEditor value={listingIntro} onChange={setIntro} /><PortalIconAction icon={RotateCcw} label="Reset to template" disabled={intro === null} onClick={() => setIntro(null)} /></div>
                    {listingShare.listings.map((listing, index) => <div key={index} className="mb-2 rounded-xl border border-border p-3"><strong>{listing.title}</strong>{listing.detailLines.map((line, lineIndex) => <div key={lineIndex} className="text-xs text-muted">{line}</div>)}</div>)}
                    <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="my-3 inline-block rounded-xl bg-primary px-6 py-3 font-semibold text-white">{listingShareButtonLabel(listingShare.listings.length)}</a>
                    <p className="break-all text-xs text-muted">{linkUrl}</p>
                    <p className="mt-5 whitespace-pre-line">{listingShare.signature?.join("\n")}</p>
                  </div></div> : <div className="whitespace-pre-wrap break-words bg-accent/20 p-6 text-sm leading-relaxed">{invitePreviewBody}</div>}
                </section> : null}
                {viaSms ? <section className="rounded-2xl border border-border p-4" aria-label="Text message preview"><div className="mb-4 text-sm">From: {workNumber}<br />To: {prospectPhone}</div><div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary p-4 text-sm text-white">{inviteSmsBody}</div></section> : null}
                {kind !== "listing" ? <div><div className="flex items-center justify-between"><label htmlFor="share-lead-message">Message</label><PortalIconAction icon={RotateCcw} label="Reset message" disabled={!note} onClick={() => { setNote(""); setIntro(null); }} /></div><textarea id="share-lead-message" aria-label="Message" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-xl border border-border bg-card p-3 text-sm" rows={3} /></div> : null}
              </div>}
            </div>
            <aside className="hidden lg:block" aria-label="Inbox preview"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Inbox</h3><div className="rounded-2xl border border-border p-4"><div className="truncate font-semibold">{sender?.name || "Loading…"}</div><div className="my-1 text-sm font-medium">{subject}</div><p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted">{previewBody}</p></div></aside>
          </div>
        </WizardShell>
      </div>
    </ListingWizardOverlay>
  );
}
