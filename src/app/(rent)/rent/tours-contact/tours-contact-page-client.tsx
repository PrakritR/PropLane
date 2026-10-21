"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { MockProperty } from "@/data/types";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import { ManagerLinkGate } from "@/components/marketing/manager-link-gate";
import { SmsConsentCheckbox } from "@/components/marketing/sms-consent-checkbox";
import Link from "next/link";
import "@/components/public-site/journey-forms.css";
import { JourneyHouseCard } from "@/components/public-site/journey-house-card";
import { JourneyPicker, type JourneyPickerOption } from "@/components/public-site/journey-picker";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  residentCreateAccountHref,
  residentSignInHref,
} from "@/lib/resident-public-nav";
import {
  BROWSE_IDS_PARAM,
  buildTourContactHref,
  parseBrowseIdsParam,
} from "@/lib/manager-property-links";
import {
  TourScheduleFlow,
  isTourRoomUndecided,
  TOUR_ROOM_UNDECIDED_KEY,
  TOUR_ROOM_UNDECIDED_LABEL,
} from "@/components/marketing/tour-schedule-flow";
import {
  ensureSignedInResidentPortal,
} from "@/lib/tour-resident-link.client";
import {
  ProspectGuestAccountGate,
  ProspectResidentPortalMessagePrompt,
  ProspectResidentPortalTourPrompt,
  ProspectSignedInResidentGate,
} from "@/components/marketing/prospect-action-account-gate";
import {
  ProspectAccountHandoff,
  ProspectPublicSuccessBanner,
  ProspectViewInPortalAction,
  PS_PROSPECT_CANVAS_CLASS,
} from "@/components/marketing/prospect-public-handoff";
import { prospectPortalReturnPath } from "@/lib/prospect-public-gate";
import { useProspectActionGate } from "@/hooks/use-prospect-action-gate";


export { isTourRoomUndecided, TOUR_ROOM_UNDECIDED_KEY, TOUR_ROOM_UNDECIDED_LABEL };

type Tab = "tour" | "message";

const TOPICS = [
  "General leasing question",
  "Availability & move-in dates",
  "Neighborhood & area",
  "Application process",
  "Pricing & fees",
  "Pet policy",
  "Other",
];

export function ToursContactPageClient({ signedInNonResident = false }: { signedInNonResident?: boolean }) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get("tab")?.trim().toLowerCase();
  const initialTab: Tab = tabFromUrl === "message" ? "message" : "tour";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [extrasTick, setExtrasTick] = useState(0);
  const linkedPropertyId = searchParams.get("propertyId")?.trim() ?? "";
  const portfolioPropertyIds = useMemo(() => {
    if (linkedPropertyId) return [];
    return parseBrowseIdsParam(searchParams.get(BROWSE_IDS_PARAM));
  }, [linkedPropertyId, searchParams]);
  const nextPath = searchParams.get("next")?.trim() ?? "";
  const tourReturnPath = linkedPropertyId ? buildTourContactHref(linkedPropertyId) : "/rent/tours-contact";
  const returnAfterAuth = nextPath.startsWith("/") ? nextPath : tourReturnPath;

  useEffect(() => {
    if (!portfolioPropertyIds.length) return;
    void Promise.all(portfolioPropertyIds.map((id) => loadPublicPropertyLeadFromServer(id))).then(() => {
      setExtrasTick((n) => n + 1);
    });
  }, [portfolioPropertyIds]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const on = () => setExtrasTick((n) => n + 1);
    if (linkedPropertyId) {
      void loadPublicPropertyLeadFromServer(linkedPropertyId).then(() => on());
    }
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [linkedPropertyId]);

  const linkedProperty = useMemo(() => {
    void extrasTick;
    if (!linkedPropertyId) return undefined;
    return getPropertyForPublicLink(linkedPropertyId);
  }, [extrasTick, linkedPropertyId]);

  const portfolioProperties = useMemo(() => {
    void extrasTick;
    if (!portfolioPropertyIds.length) return [];
    return portfolioPropertyIds
      .map((id) => getPropertyForPublicLink(id))
      .filter((property): property is MockProperty => Boolean(property));
  }, [extrasTick, portfolioPropertyIds]);

  const contactAutofill = useProspectContactAutofill();
  const tourGate = useProspectActionGate("tour", linkedPropertyId, signedInNonResident, contactAutofill);

  // The house the page is about: a linked home, once it has loaded. Drawn beside the flow on desktop.
  const showHouse = Boolean(linkedProperty) && portfolioPropertyIds.length === 0;

  return (
    <div className="ps ps-j-page">
      <div className="ps-j-col">
        <div className="ps-j-title">
          <h1 className="ps-h1">{tab === "tour" ? "Book a tour" : "Message PropLane"}</h1>
        </div>

        <div className={showHouse ? "ps-j-grid" : undefined}>
          {showHouse && linkedProperty ? (
            <aside>
              <JourneyHouseCard property={linkedProperty} />
            </aside>
          ) : null}

          <div className="ps-j-stack" style={{ minWidth: 0 }}>
            <div className="ps-j-tabs" role="tablist" aria-label="Tour or message">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "tour"}
                className="ps-j-tab"
                data-attr="tours-contact-tab-tour"
                onClick={() => setTab("tour")}
              >
                Tour
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "message"}
                className="ps-j-tab"
                data-attr="tours-contact-tab-message"
                onClick={() => setTab("message")}
              >
                Message
              </button>
            </div>

            <div key={tab}>
              {tab === "tour" ? (
                portfolioPropertyIds.length > 0 && portfolioProperties.length === 0 ? (
                  <ManagerLinkGate
                    ps
                    title="Open your manager’s tour link"
                    body="This tour link is invalid or no longer active. Ask your property manager for a new tour link."
                  />
                ) : portfolioProperties.length > 0 ? (
                  <TourPropertyPicker
                    properties={portfolioProperties}
                    onSelectProperty={(propertyId) => {
                      router.push(buildTourContactHref(propertyId));
                    }}
                  />
                ) : !linkedPropertyId || !linkedProperty ? (
                  <ManagerLinkGate
                    ps
                    title="Open your manager’s tour link"
                    body={
                      linkedPropertyId && !linkedProperty
                        ? "This property link is invalid or no longer active. Ask your property manager for a new tour link."
                        : "Tours start from a link your property manager shares after you find a unit on Zillow, Redfin, or elsewhere."
                    }
                  />
                ) : !tourGate.ready ? (
                  <div className="ps-mute" aria-busy="true">
                    Loading…
                  </div>
                ) : tourGate.gateView === "resident-portal" ? (
                  <ProspectResidentPortalTourPrompt
                    propertyId={linkedProperty.id}
                    propertyTitle={linkedProperty.title}
                  />
                ) : tourGate.gateView !== "action" ? (
                  tourGate.gateView === "signed-in-create-resident" ? (
                    <ProspectSignedInResidentGate
                      action="tour"
                      returnPath={tourGate.portalReturn}
                      propertyTitle={linkedProperty.title}
                    />
                  ) : (
                    <ProspectGuestAccountGate
                      action="tour"
                      gateKey={tourGate.gateKey}
                      returnPath={tourGate.portalReturn}
                      propertyTitle={linkedProperty.title}
                    />
                  )
                ) : (
                  <TourScheduleFlow
                    property={linkedProperty}
                    returnAfterAuth={returnAfterAuth}
                    onSuccess={() => showToast("Tour requested.")}
                  />
                )
              ) : !linkedPropertyId || !linkedProperty ? (
                <ManagerLinkGate
                  ps
                  title="Open your manager’s property link"
                  body={
                    linkedPropertyId && !linkedProperty
                      ? "This property link is invalid or no longer active. Ask your property manager for a new link."
                      : "Messages about a listing start from a link your property manager shares with the property ID."
                  }
                />
              ) : (
                <MessageFlow
                  propertyId={linkedProperty.id}
                  propertyTitle={linkedProperty.title}
                  propertyAddress={linkedProperty.address}
                  signedInNonResident={signedInNonResident}
                  contactAutofill={contactAutofill}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TourPropertyPicker({
  properties,
  onSelectProperty,
}: {
  properties: MockProperty[];
  onSelectProperty: (propertyId: string) => void;
}) {
  const options: JourneyPickerOption[] = useMemo(
    () =>
      properties.map((property) => ({
        id: property.id,
        title: property.title,
        place: property.address || property.neighborhood,
        figure: property.rentLabel,
        searchText: `${property.neighborhood} ${property.buildingName} ${property.unitLabel}`,
      })),
    [properties],
  );

  return (
    <div className={PS_PROSPECT_CANVAS_CLASS} style={{ gap: 18 }}>
      <h2 className="ps-h3">Choose a home to tour</h2>
      <JourneyPicker
        options={options}
        value={null}
        onChange={onSelectProperty}
        placeholder="Search by address, neighborhood, or property name"
        emptyMessage="No properties match your search."
        listEmptyMessage="No properties are available from this link."
        ariaLabel="Search properties to tour"
        searchAbove={5}
      />
    </div>
  );
}

function MessageFlow({
  propertyId,
  propertyTitle,
  signedInNonResident = false,
  contactAutofill,
}: {
  propertyId: string;
  propertyTitle?: string;
  propertyAddress?: string;
  signedInNonResident?: boolean;
  contactAutofill: ReturnType<typeof useProspectContactAutofill>;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const [submitted, setSubmitted] = useState(false);
  const [submittedContact, setSubmittedContact] = useState<{
    name: string;
    email: string;
    phone: string;
    topic: string;
  } | null>(null);
  const signedInUserId = contactAutofill.userId;
  const hasResidentRole = contactAutofill.hasResidentRole;
  const [topic, setTopic] = useState("");
  const [otherTopicDetail, setOtherTopicDetail] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [linkingSignedInAccount, setLinkingSignedInAccount] = useState(false);
  const isOther = topic === "Other";

  const messageGate = useProspectActionGate("message", propertyId, signedInNonResident, contactAutofill);

  useEffect(() => {
    if (!contactAutofill.ready) return;
    if (contactAutofill.name) setName((prev) => prev || contactAutofill.name);
    if (contactAutofill.email) setEmail((prev) => prev || contactAutofill.email);
    if (contactAutofill.phone) setPhone((prev) => prev || contactAutofill.phone);
  }, [contactAutofill.ready, contactAutofill.name, contactAutofill.email, contactAutofill.phone]);

  const handleSend = async () => {
    if (!topic) {
      showToast("Please select a topic.");
      return;
    }
    const resolvedTopic = isOther ? otherTopicDetail.trim() : topic;
    if (isOther && !otherTopicDetail.trim()) {
      showToast("Please describe your topic.");
      return;
    }
    const n = name.trim();
    const em = email.trim();
    const msg = message.trim();
    if (!n || !em.includes("@")) {
      showToast("Please enter your name and email.");
      return;
    }
    if (!msg) {
      showToast("Please enter a message.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/property-lead-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          name: n,
          email: em,
          phone: phone.trim() || undefined,
          smsConsent,
          smsConsentAt: smsConsent ? new Date().toISOString() : undefined,
          topic: resolvedTopic,
          body: msg,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not send message.");
        return;
      }
      setSubmittedContact({
        name: n,
        email: em,
        phone: phone.trim(),
        topic: resolvedTopic,
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!submitted || !submittedContact || !signedInUserId || linkingSignedInAccount) return;

    const communicationReturn = prospectPortalReturnPath("message", { propertyId });
    setLinkingSignedInAccount(true);

    void (async () => {
      if (hasResidentRole) {
        router.replace(communicationReturn);
        return;
      }
      // Email only. Forwarding the prospect-form phone reaches
      // `applyProspectMessagingContactToProfile`, which overwrites
      // `profiles.phone` and retires `phone_verified_at` with it — so a
      // signed-in manager typing a secondary number here would silently lose the
      // verified SMS identity `portal-inbox-delivery` and `claw-manager-actions`
      // both trust. The gate only needs the email.
      const ensured = await ensureSignedInResidentPortal(communicationReturn, {
        contactEmail: submittedContact.email,
      });
      if (ensured.ok) {
        router.replace(ensured.redirectTo);
        return;
      }
      showToast(ensured.error ?? "Could not open Communication.");
      setLinkingSignedInAccount(false);
    })();
  }, [
    submitted,
    submittedContact,
    signedInUserId,
    hasResidentRole,
    linkingSignedInAccount,
    propertyId,
    router,
    showToast,
  ]);

  if (submitted && submittedContact) {
    const communicationReturn = prospectPortalReturnPath("message", { propertyId });
    const createAccountHref = residentCreateAccountHref(communicationReturn, {
      email: submittedContact.email,
      fullName: submittedContact.name,
      phone: submittedContact.phone || undefined,
      handoff: "message",
    });
    const signInHref = residentSignInHref(communicationReturn, {
      email: submittedContact.email,
      fullName: submittedContact.name,
      phone: submittedContact.phone || undefined,
      handoff: "message",
    });

    if (signedInUserId) {
      return (
        <div className={PS_PROSPECT_CANVAS_CLASS}>
          <ProspectPublicSuccessBanner ps eyebrow="Message sent" title="Your message is in">
            <p>
              We sent your message to the property manager{propertyTitle ? ` about ${propertyTitle}` : ""}. Opening
              Communication…
            </p>
            <p style={{ margin: 0, fontWeight: 600 }}>Topic: {submittedContact.topic}</p>
          </ProspectPublicSuccessBanner>
        </div>
      );
    }

    return (
      <div className={PS_PROSPECT_CANVAS_CLASS}>
        <ProspectPublicSuccessBanner ps eyebrow="Message sent" title="Your message is in">
          <p>
            We sent your message to the property manager{propertyTitle ? ` about ${propertyTitle}` : ""}.
            {signedInUserId
              ? " You can read manager replies in PropLane Communication."
              : " You will get replies by email, and you can read them in PropLane Communication once you have a resident account."}
          </p>
          <p style={{ margin: 0, fontWeight: 600 }}>Topic: {submittedContact.topic}</p>
        </ProspectPublicSuccessBanner>

        {!signedInUserId ? (
          <ProspectAccountHandoff
            ps
            title="Create an account to read replies in PropLane"
            description="Your message was sent. Create a free resident account to read manager replies in Communication and keep the conversation in one place."
            createAccountHref={createAccountHref}
            signInHref={signInHref}
            createAccountDataAttr="message-success-create-account"
            signInDataAttr="message-success-sign-in"
          />
        ) : hasResidentRole ? (
          <ProspectViewInPortalAction
            ps
            signedIn
            hasResidentRole
            portalPath={communicationReturn}
            dataAttr="message-success-view-in-portal"
          />
        ) : (
          <ProspectAccountHandoff
            ps
            title="Add a resident account to read replies in PropLane"
            description="Your message was sent. Add a resident account on your login to read manager replies in Communication."
            createAccountHref={createAccountHref}
            signInHref={signInHref}
            createAccountDataAttr="message-success-create-resident-account"
            signInDataAttr="message-success-sign-in-existing"
          />
        )}

      </div>
    );
  }

  if (!messageGate.ready) {
    return (
      <div className="ps-mute" aria-busy="true">
        Loading…
      </div>
    );
  }

  if (messageGate.gateView === "resident-portal") {
    return (
      <ProspectResidentPortalMessagePrompt propertyId={propertyId} propertyTitle={propertyTitle} />
    );
  }

  if (messageGate.gateView !== "action") {
    return messageGate.gateView === "signed-in-create-resident" ? (
      <ProspectSignedInResidentGate
        action="message"
        returnPath={messageGate.portalReturn}
        propertyTitle={propertyTitle}
      />
    ) : (
      <ProspectGuestAccountGate
        action="message"
        gateKey={messageGate.gateKey}
        returnPath={messageGate.portalReturn}
        propertyTitle={propertyTitle}
      />
    );
  }

  return (
    <div className={PS_PROSPECT_CANVAS_CLASS}>
      <div className="ps-j-stack" style={{ gap: 20 }}>
        <Field label="What do you need help with? *">
          <select
            value={topic}
            onChange={(e) => {
              const v = e.target.value;
              setTopic(v);
              if (v !== "Other") setOtherTopicDetail("");
            }}
            className="ps-select"
            data-attr="tours-contact-topic"
          >
            <option value="">Select a topic</option>
            {TOPICS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {isOther ? (
          <Field label="Describe your topic *">
            <input
              type="text"
              value={otherTopicDetail}
              onChange={(e) => setOtherTopicDetail(e.target.value)}
              placeholder="Type what you need help with"
              className={inputCls}
            />
          </Field>
        ) : null}
        <p style={{ margin: 0, fontSize: 14 }}>
          Rent, payments, maintenance or login issues go through the{" "}
          <Link href="/resident/dashboard" className="ps-link">
            resident portal
          </Link>
          .
        </p>
      </div>

      <div className="ps-j-stack" style={{ gap: 18 }}>
        <div className="ps-j-grid2">
          <Field label="Name *">
            <input type="text" placeholder="Jane Smith" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email *">
            <input type="email" placeholder="jane@email.com" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field label="Phone">
          <PhoneNumberField value={phone} onChange={setPhone} dataAttr="tours-contact-phone" />
        </Field>
        <Field label="Message *">
          <textarea rows={4} placeholder="Tell us more so we can help…" className={`${inputCls} resize-none`} style={{ paddingBlock: 10 }} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <SmsConsentCheckbox checked={smsConsent} onChange={setSmsConsent} inputId="message-sms-consent" ps />
      </div>

      <button
        type="button"
        onClick={handleSend}
        disabled={submitting}
        data-attr="property-lead-message-send"
        className="ps-btn ps-btn-blue ps-btn-block"
      >
        {submitting ? "Sending…" : "Send message"}
      </button>
    </div>
  );
}

function Field({
  label,
  children,
  fieldKey,
  error,
}: {
  label: string;
  children: React.ReactNode;
  fieldKey?: string;
  error?: string;
}) {
  return (
    <div className="ps-field" data-wizard-field={fieldKey}>
      <span>{label}</span>
      {children}
      {error ? <span className="ps-error">{error}</span> : null}
    </div>
  );
}

const inputCls = "ps-input";
