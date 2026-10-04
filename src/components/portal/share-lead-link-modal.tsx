"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  ReviewCard,
  WizardField,
  WizardLine,
  WizardMultiSelect,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ShareLeadLinkPreviewPanel } from "@/components/portal/share-lead-link-preview-panel";
import { Copy, RotateCcw } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";

import { useAppUi } from "@/components/providers/app-ui-provider";
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
  buildManagerLeaseSignUrl,
  buildManagerPortfolioTourUrl,
  buildManagerTourUrl,
  copyTextToClipboard,
} from "@/lib/manager-property-links";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue, propertyAllowsShortTermRental } from "@/lib/rental-application/data";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { applicationFormChoicesForProperty, applicationFormIdForLink, defaultApplicationFormId } from "@/lib/send-forms";
import { normalizeManagerSmsConversationsPayload } from "@/lib/manager-sms-messages";
import {
  portalMessageChannelsFromSelection,
  PortalMessageSendViaDropdown,
  PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS,
} from "@/components/portal/portal-message-compose-fields";
import type { NotificationDeliveryChannels } from "@/components/portal/portal-notification-preview-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import { partitionTourAvailabilityStoredKeys } from "@/lib/tour-slot-math";
import Link from "next/link";
import { activeWorkspaceScope } from "@/lib/workspaces/selection";

import { DEFAULT_LISTING_SHARED_INTRO, LISTING_SHARED_TEMPLATE_KEY, renderListingSharedIntro } from "@/lib/listing-shared-template";
import { normalizeAutomatedMessageSettings } from "@/lib/automated-messages-settings";

function shareLinkRowLabel(kind: LeadInviteKind): string {
  if (kind === "apply") return "Apply link";
  if (kind === "tour") return "Tour link";
  if (kind === "listing") return "Listing link";
  return "Lease link";
}

/** Portfolio labels sometimes repeat the same room-count fragment ("3 rooms · 3 rooms"). */
function normalizeSharePropertyLabel(label: string): string {
  const parts = label.split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return label.trim();
  const tail = parts[parts.length - 1]!;
  if (parts.length >= 2 && parts[parts.length - 2]!.endsWith(tail)) {
    return parts.slice(0, -1).join(" · ");
  }
  const out: string[] = [];
  for (const part of parts) {
    if (out[out.length - 1] !== part) out.push(part);
  }
  return out.join(" · ");
}

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
  initialRecipient,
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
  /** A resident the manager is sending to from their record: name, email and phone start filled in. */
  initialRecipient?: { name?: string; email?: string; phone?: string };
}) {
  const { showToast } = useAppUi();
  const { userId: managerUserId } = useManagerUserId();
  const multiEnabled = properties.length > 1;
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [roomChoice, setRoomChoice] = useState("");
  /** The published application form this link hands out; "" = the property's default form. */
  const [applicationFormId, setApplicationFormId] = useState("");
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
    setApplicationFormId("");
    setApplyRentalTypes(["standard"]);
    setProspectName(initialRecipient?.name?.trim() ?? "");
    setProspectEmail(initialRecipient?.email?.trim() ?? "");
    setProspectPhone(initialRecipient?.phone?.trim() ?? "");
    setSendVia(["email"]);
    setNote("");
    setIntro(null);
    setStep(0);
    setSendBusy(false);
    // Reset only when the modal opens; the recipient is read at that moment (see `wasOpenRef`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const raw = properties.find((p) => p.id === singlePropertyId)?.label ?? singlePropertyId;
    return normalizeSharePropertyLabel(raw);
  }, [properties, singlePropertyId, isMultiProperty, propertyIds.length, kind]);

  const portfolioTourUrl = useMemo(() => {
    if (!isPortfolioTour || typeof window === "undefined") return "";
    return buildManagerPortfolioTourUrl(linkOrigin, propertyIds);
  }, [isPortfolioTour, propertyIds, linkOrigin]);

  const roomOptions = useMemo(() => {
    if ((kind !== "apply" && kind !== "lease") || !singlePropertyId) return [];
    return getRoomOptionsForProperty(singlePropertyId, { includeUnavailable: true }).filter((o) => o.value);
  }, [kind, singlePropertyId]);

  /** The property's published application forms; a picker shows only when there is a real choice. */
  const applicationFormChoices = useMemo(() => {
    if (kind !== "apply" || !singlePropertyId) return [];
    const submission = getPropertyById(singlePropertyId)?.listingSubmission;
    return applicationFormChoicesForProperty(submission && submission.v === 1 ? submission : null);
  }, [kind, singlePropertyId]);
  const selectedApplicationFormId = applicationFormChoices.some((choice) => choice.id === applicationFormId)
    ? applicationFormId
    : defaultApplicationFormId(applicationFormChoices);
  /** Carried on the link only when it is not the default form. */
  const linkApplicationFormId = useMemo(() => {
    const submission = singlePropertyId ? getPropertyById(singlePropertyId)?.listingSubmission : null;
    return applicationFormIdForLink(submission && submission.v === 1 ? submission : null, selectedApplicationFormId);
  }, [singlePropertyId, selectedApplicationFormId]);

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
    if (isMultiListing) {
      return buildManagerBrowseUrl(origin, propertyIds, { workspaceName: activeWorkspaceScope()?.name });
    }
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
      applicationFormId: linkApplicationFormId,
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
    linkApplicationFormId,
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
          applicationFormId: kind === "apply" && !isMultiApply ? selectedApplicationFormId || undefined : undefined,
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

  const subject = leadInviteSubject(kind, propertyTitle, isMultiProperty ? propertyIds.length : undefined);
  const emailValid = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(prospectEmail.trim());
  const phoneValid = prospectPhone.replace(/\D/g, "").length >= 10;
  const recipientReady =
    (viaEmail || viaSms) &&
    (!viaEmail || emailValid) &&
    (!viaSms || (smsAvailable && phoneValid));

  const workspaceSteps = useMemo<AddWorkspaceStep[]>(() => {
    const homeIncomplete = propertyIds.length === 0;
    const recipientIncomplete = !recipientReady;
    const recipientSummary = prospectName.trim()
      ? [prospectName.trim(), viaEmail ? prospectEmail.trim() : "", viaSms ? prospectPhone.trim() : ""].filter(Boolean).join(" · ")
      : "Who receives this";
    return [
      { id: "home", label: "Home", incomplete: homeIncomplete, summary: propertyTitle || "No property yet" },
      { id: "recipient", label: "Recipient", incomplete: recipientIncomplete, summary: recipientSummary },
      {
        id: "review",
        label: "Review",
        incomplete: homeIncomplete || recipientIncomplete,
        summary: homeIncomplete || recipientIncomplete ? "Finish required fields" : "Ready to send",
      },
    ];
  }, [propertyIds.length, propertyTitle, prospectEmail, prospectName, prospectPhone, recipientReady, viaEmail, viaSms]);

  const stepId = workspaceSteps[Math.min(step, workspaceSteps.length - 1)]?.id ?? "home";
  const goTo = (id: string) => {
    const idx = workspaceSteps.findIndex((s) => s.id === id);
    if (idx >= 0) setStep(idx);
  };
  const linkLabel = shareLinkRowLabel(kind);

  const invitePreviewPanel = (
    <ShareLeadLinkPreviewPanel
      kind={kind}
      prospectName={prospectName}
      prospectEmail={prospectEmail}
      prospectPhone={prospectPhone}
      propertyTitle={propertyTitle}
      viaEmail={viaEmail}
      viaSms={viaSms}
      senderName={sender?.name ?? ""}
      workNumber={workNumber}
      previewBody={previewBody}
      propertyMissing={propertyIds.length === 0}
      recipientReady={recipientReady}
    />
  );

  if (!open) return null;

  return (
    <AddWorkspace
      title={inviteTitle}
      steps={workspaceSteps}
      current={step}
      onJump={setStep}
      onClose={onClose}
      hideFooterStepCount
      reviewEditLinks
      assistantContext={inviteTitle}
      assistantScopeKey={`share-lead-${kind}`}
      dataAttrPrefix="share-lead"
      finishDataAttr="share-lead-send"
      lastLabel="Send"
      lastDisabled={!propertyIds.length || !recipientReady || !sender}
      nextDisabled={step === 0 && propertyIds.length === 0}
      busy={sendBusy}
      dirty={Boolean(prospectName.trim() || prospectEmail.trim() || prospectPhone.trim() || note.trim())}
      onBeforeNext={() => {
        if (stepId === "home" && propertyIds.length === 0) {
          showToast("Select a property first.");
          return false;
        }
        if (stepId === "recipient") {
          if (!viaEmail && !viaSms) {
            showToast("Choose email, SMS, or both.");
            return false;
          }
          if (viaEmail && !emailValid) {
            showToast("Enter a valid prospect email.");
            return false;
          }
          if (viaSms && !smsAvailable) {
            showToast("A work number is required to send text messages.");
            return false;
          }
          if (viaSms && !phoneValid) {
            showToast("Enter a valid prospect phone number for SMS.");
            return false;
          }
        }
        return true;
      }}
      onFinish={() => void sendInvite()}
    >
      <div className="grid min-h-0 grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(260px,380px)]">
        <div className="min-w-0">
      {stepId === "home" ? (
        <StepColumn>
          <StepHeading title="Home" />
          {properties.length === 0 ? (
            <p role="status">No active properties to share.</p>
          ) : (
            <>
              <WizardSection title="Property" dataAttr="share-lead-home">
                {multiEnabled && kind !== "lease" ? (
                  <WizardMultiSelect
                    label="Properties"
                    dataAttr="share-lead-property-multi"
                    emptyLabel="Select properties"
                    emptyMenuText="No properties"
                    options={properties.map((p) => ({ value: p.id, label: normalizeSharePropertyLabel(p.label) }))}
                    selected={propertyIds}
                    onChange={(next) => {
                      setPropertyIds(next);
                      setRoomChoice("");
                    }}
                    required
                  />
                ) : (
                  <WizardSelect
                    label="Property"
                    value={singlePropertyId}
                    onChange={(next) => {
                      setPropertyIds(next ? [next] : []);
                      setRoomChoice("");
                      setApplicationFormId("");
                    }}
                    options={properties.map((p) => ({ value: p.id, label: normalizeSharePropertyLabel(p.label) }))}
                    placeholder="Select property…"
                    dataAttr="share-lead-property"
                    required
                  />
                )}
                {kind === "apply" && shortTermApplyAvailable ? (
                  <div className="mt-3">
                    <WizardSelect
                      label="Application"
                      value={applyRentalTypes[0] ?? "standard"}
                      onChange={(next) => setApplyRentalTypes([next])}
                      options={APPLY_RENTAL_TYPE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                      dataAttr="share-lead-application-type"
                    />
                  </div>
                ) : null}
                {applicationFormChoices.length > 1 ? (
                  <div className="mt-3">
                    <WizardSelect
                      label="Application form"
                      value={selectedApplicationFormId}
                      onChange={setApplicationFormId}
                      options={applicationFormChoices.map((choice) => ({ value: choice.id, label: choice.label }))}
                      dataAttr="share-lead-application-form"
                    />
                  </div>
                ) : null}
                {singlePropertyId && roomOptions.length > 0 ? (
                  <div className="mt-3">
                    <WizardSelect
                      label="Room"
                      value={roomChoice}
                      onChange={setRoomChoice}
                      options={[{ value: "", label: "Any room" }, ...roomOptions.map((option) => ({ value: option.value, label: option.label }))]}
                      dataAttr="share-lead-room"
                    />
                  </div>
                ) : null}
                <div className="mt-3 border-t border-border/60 pt-3">
                  <WizardLine
                    label={linkLabel}
                    control={
                      <span className="flex max-w-[min(320px,55vw)] items-center gap-1">
                        <span className="truncate text-[13px] font-semibold text-foreground">{linkUrl || "—"}</span>
                        <PortalIconAction
                          icon={Copy}
                          label={`Copy ${linkLabel.toLowerCase()}`}
                          disabled={!linkUrl}
                          data-attr="share-lead-copy-link"
                          onClick={() => void handleCopy(linkUrl, "Link copied.")}
                        />
                      </span>
                    }
                  />
                </div>
              </WizardSection>
              {propertiesMissingTourAvailability.length > 0 ? (
                <div role="status" data-attr="share-lead-tour-availability-warning" className="rounded-2xl border border-amber-200 bg-card p-4 text-sm">
                  <p>{propertiesMissingTourAvailability.map((property) => property.label).join(", ")} has no open tour windows yet.</p>
                  <Link href="/portal/calendar" data-attr="share-lead-tour-availability-calendar-link" className="font-semibold text-primary">
                    Open Calendar to add availability
                  </Link>
                </div>
              ) : null}
            </>
          )}
        </StepColumn>
      ) : null}

      {stepId === "recipient" ? (
        <StepColumn>
          <StepHeading title="Recipient" />
          <WizardSection title="Delivery" dataAttr="share-lead-delivery">
            <PortalMessageSendViaDropdown selected={sendVia} onChange={setSendVia} smsAvailable={smsAvailable} footerNote="" dataAttr="share-lead-send-via" />
          </WizardSection>
          <WizardSection title="Contact" dataAttr="share-lead-recipient">
            <div className={PORTAL_MESSAGE_COMPOSE_TWO_COL_CLASS}>
              <WizardField label="Name">
                <Input id="share-lead-name" value={prospectName} onChange={(e) => setProspectName(e.target.value)} data-attr="share-lead-name" />
              </WizardField>
              {viaEmail ? (
                <WizardField label="Email" required>
                  <Input id="share-lead-email" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} data-attr="share-lead-email" />
                </WizardField>
              ) : null}
              {viaSms ? (
                <WizardField label="Phone" required>
                  <PhoneNumberField id="share-lead-phone" value={prospectPhone} onChange={setProspectPhone} dataAttr="share-lead-phone" />
                </WizardField>
              ) : null}
            </div>
          </WizardSection>
        </StepColumn>
      ) : null}

      {stepId === "review" ? (
        <StepColumn>
          <StepHeading title="Review" />
          <ReviewCard
            title="Home"
            status={propertyIds.length === 0 ? "incomplete" : "complete"}
            onEdit={() => goTo("home")}
            dataAttr="share-lead-review-home"
            facts={[
              { label: "Property", value: propertyTitle || "Not set", missing: propertyIds.length === 0 },
              ...(applicationFormChoices.length > 1
                ? [{ label: "Application form", value: applicationFormChoices.find((choice) => choice.id === selectedApplicationFormId)?.label ?? "Default" }]
                : []),
              { label: linkLabel, value: linkUrl ? "Ready" : "Not set", missing: !linkUrl },
            ]}
          />
          <ReviewCard
            title="Recipient"
            status={recipientReady ? "complete" : "incomplete"}
            onEdit={() => goTo("recipient")}
            dataAttr="share-lead-review-recipient"
            facts={[
              { label: "Name", value: prospectName.trim() || "—" },
              { label: "Channel", value: viaEmail && viaSms ? "Email and text" : viaSms ? "Text" : viaEmail ? "Email" : "Not set", missing: !viaEmail && !viaSms },
              ...(viaEmail ? [{ label: "Email", value: prospectEmail.trim() || "Not set", missing: !emailValid }] : []),
              ...(viaSms ? [{ label: "Phone", value: prospectPhone.trim() || "Not set", missing: !phoneValid }] : []),
            ]}
          />
          {kind === "listing" ? (
            <WizardSection title="Listing email" dataAttr="share-lead-review-listing">
              <div className="space-y-2 text-sm">
                <div>Subject: {subject}</div>
                <div className="flex items-start gap-2 rounded-xl border border-border bg-accent/20 p-4">
                  <ListingIntroEditor value={listingIntro} onChange={setIntro} />
                  <PortalIconAction icon={RotateCcw} label="Reset to template" disabled={intro === null} onClick={() => setIntro(null)} />
                </div>
                {listingShare.listings.map((listing, index) => (
                  <div key={index} className="rounded-xl border border-border p-3">
                    <strong>{listing.title}</strong>
                    {listing.detailLines.map((line, lineIndex) => (
                      <div key={lineIndex} className="text-xs text-muted">{line}</div>
                    ))}
                  </div>
                ))}
              </div>
            </WizardSection>
          ) : null}
          {kind !== "listing" ? (
            <WizardSection
              title="Note"
              chip={<PortalIconAction icon={RotateCcw} label="Reset message" disabled={!note} onClick={() => { setNote(""); setIntro(null); }} />}
              dataAttr="share-lead-review-note"
            >
              <Textarea id="share-lead-message" aria-label="Message" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[96px]" data-attr="share-lead-message" />
            </WizardSection>
          ) : null}
        </StepColumn>
      ) : null}
        </div>
        <div className="hidden min-w-0 lg:block" aria-label="Invite preview column">
          {invitePreviewPanel}
        </div>
      </div>
      <div className="mt-8 border-t border-border/60 pt-6 lg:hidden" aria-label="Invite preview">
        {invitePreviewPanel}
      </div>
    </AddWorkspace>
  );
}
