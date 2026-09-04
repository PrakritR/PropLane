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
import { SegmentedTwo } from "@/components/ui/segmented-control";
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
  PropertySearchPicker,
  type PropertySearchOption,
} from "@/components/marketing/property-search-picker";
import { Select } from "@/components/ui/input";
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
  PUBLIC_PROSPECT_CANVAS_CLASS,
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

  return (
    <div className="min-h-screen px-4 py-12 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          {tab === "tour" ? "Schedule tour" : "Message PropLane"}
        </h1>

        <div className="mt-6">
          <SegmentedTwo
            value={tab}
            onChange={(id) => setTab(id)}
            left={{ id: "tour", label: "Set up tour" }}
            right={{ id: "message", label: "Send message" }}
          />
        </div>

        <div key={tab} className="animate-fade-in">
          {tab === "tour" ? (
            portfolioPropertyIds.length > 0 && portfolioProperties.length === 0 ? (
              <div className="mt-8">
                <ManagerLinkGate
                  title="Open your manager’s tour link"
                  body="This tour link is invalid or no longer active. Ask your property manager for a new tour link."
                />
              </div>
            ) : portfolioProperties.length > 0 ? (
              <TourPropertyPicker
                properties={portfolioProperties}
                onSelectProperty={(propertyId) => {
                  router.push(buildTourContactHref(propertyId));
                }}
              />
            ) : !linkedPropertyId || !linkedProperty ? (
              <div className="mt-8">
                <ManagerLinkGate
                  title="Open your manager’s tour link"
                  body={
                    linkedPropertyId && !linkedProperty
                      ? "This property link is invalid or no longer active. Ask your property manager for a new tour link."
                      : "Tours start from a link your property manager shares after you find a unit on Zillow, Redfin, or elsewhere."
                  }
                />
              </div>
            ) : !tourGate.ready ? (
              <div className={`${PUBLIC_PROSPECT_CANVAS_CLASS} mt-8 text-sm text-muted`} aria-busy="true">
                Loading…
              </div>
            ) : tourGate.gateView === "resident-portal" ? (
              <div className="mt-8">
                <ProspectResidentPortalTourPrompt
                  propertyId={linkedProperty.id}
                  propertyTitle={linkedProperty.title}
                />
              </div>
            ) : tourGate.gateView !== "action" ? (
              <div className="mt-8">
                {tourGate.gateView === "signed-in-create-resident" ? (
                  <ProspectSignedInResidentGate
                    action="tour"
                    gateKey={tourGate.gateKey}
                    returnPath={tourGate.portalReturn}
                    propertyTitle={linkedProperty.title}
                    onContinueGuest={tourGate.continueAsGuest}
                  />
                ) : (
                  <ProspectGuestAccountGate
                    action="tour"
                    gateKey={tourGate.gateKey}
                    returnPath={tourGate.portalReturn}
                    propertyTitle={linkedProperty.title}
                    onContinueGuest={tourGate.continueAsGuest}
                  />
                )}
              </div>
            ) : (
              <TourScheduleFlow
                property={linkedProperty}
                returnAfterAuth={returnAfterAuth}
                onSuccess={() => showToast("Tour booked.")}
              />
            )
          ) : !linkedPropertyId || !linkedProperty ? (
            <div className="mt-8">
              <ManagerLinkGate
                title="Open your manager’s property link"
                body={
                  linkedPropertyId && !linkedProperty
                    ? "This property link is invalid or no longer active. Ask your property manager for a new link."
                    : "Messages about a listing start from a link your property manager shares with the property ID."
                }
              />
            </div>
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
  );
}

function TourPropertyPicker({
  properties,
  onSelectProperty,
}: {
  properties: MockProperty[];
  onSelectProperty: (propertyId: string) => void;
}) {
  const options: PropertySearchOption[] = useMemo(
    () =>
      properties.map((property) => ({
        id: property.id,
        title: property.title,
        subtitle: property.address || property.neighborhood,
        tags: [property.neighborhood, property.rentLabel, property.available ? `Available ${property.available}` : ""].filter(Boolean),
        searchText: `${property.title} ${property.address} ${property.neighborhood} ${property.buildingName} ${property.unitLabel}`,
      })),
    [properties],
  );

  return (
    <div className={PUBLIC_PROSPECT_CANVAS_CLASS}>
      <p className="text-sm font-semibold text-foreground">Choose a property to tour</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Your property manager shared several homes. Pick the one you would like to visit and we will show available tour times.
      </p>
      <div className="mt-5">
        <PropertySearchPicker
          options={options}
          value={null}
          onChange={(propertyId) => {
            if (propertyId) onSelectProperty(propertyId);
          }}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No properties are available from this link."
          ariaLabel="Search properties to tour"
        />
      </div>
    </div>
  );
}

function MessageFlow({
  propertyId,
  propertyTitle,
  propertyAddress,
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
        <div className={PUBLIC_PROSPECT_CANVAS_CLASS}>
          <ProspectPublicSuccessBanner eyebrow="Message sent" title="Your message is in">
            <p>
              We sent your message to the property manager{propertyTitle ? ` about ${propertyTitle}` : ""}. Opening
              Communication…
            </p>
            <p className="font-medium">Topic: {submittedContact.topic}</p>
          </ProspectPublicSuccessBanner>
        </div>
      );
    }

    return (
      <div className={PUBLIC_PROSPECT_CANVAS_CLASS}>
        <ProspectPublicSuccessBanner eyebrow="Message sent" title="Your message is in">
          <p>
            We sent your message to the property manager{propertyTitle ? ` about ${propertyTitle}` : ""}.
            {signedInUserId
              ? " You can read manager replies in PropLane Communication."
              : " You will get replies by email, and you can read them in PropLane Communication once you have a resident account."}
          </p>
          <p className="font-medium">Topic: {submittedContact.topic}</p>
        </ProspectPublicSuccessBanner>

        {!signedInUserId ? (
          <ProspectAccountHandoff
            title="Create an account to read replies in PropLane"
            description="Your message was sent. Create a free resident account to read manager replies in Communication and keep the conversation in one place."
            createAccountHref={createAccountHref}
            signInHref={signInHref}
            createAccountDataAttr="message-success-create-account"
            signInDataAttr="message-success-sign-in"
          />
        ) : hasResidentRole ? (
          <ProspectViewInPortalAction
            signedIn
            hasResidentRole
            portalPath={communicationReturn}
            dataAttr="message-success-view-in-portal"
          />
        ) : (
          <ProspectAccountHandoff
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
      <div className={`${PUBLIC_PROSPECT_CANVAS_CLASS} mt-8 text-sm text-muted`} aria-busy="true">
        Loading…
      </div>
    );
  }

  if (messageGate.gateView === "resident-portal") {
    return (
      <div className="mt-8">
        <ProspectResidentPortalMessagePrompt propertyId={propertyId} propertyTitle={propertyTitle} />
      </div>
    );
  }

  if (messageGate.gateView !== "action") {
    return (
      <div className="mt-8">
        {messageGate.gateView === "signed-in-create-resident" ? (
          <ProspectSignedInResidentGate
            action="message"
            gateKey={messageGate.gateKey}
            returnPath={messageGate.portalReturn}
            propertyTitle={propertyTitle}
            onContinueGuest={messageGate.continueAsGuest}
          />
        ) : (
          <ProspectGuestAccountGate
            action="message"
            gateKey={messageGate.gateKey}
            returnPath={messageGate.portalReturn}
            propertyTitle={propertyTitle}
            onContinueGuest={messageGate.continueAsGuest}
          />
        )}
      </div>
    );
  }

  return (
    <div className={PUBLIC_PROSPECT_CANVAS_CLASS}>
      {propertyTitle ? (
        <div className="text-sm">
          <p className="font-semibold text-foreground">{propertyTitle}</p>
          {propertyAddress ? <p className="mt-1 text-muted">{propertyAddress}</p> : null}
        </div>
      ) : null}

      <div className="space-y-4">
        <div>
          <h2 className="text-base font-bold text-foreground">Topic</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            For rent, payments, maintenance, or portal login issues, use the{" "}
            <Link href="/resident/dashboard" className="font-semibold text-primary hover:underline">
              resident portal
            </Link>
            . These topics are for leasing questions, the area around our homes, and availability.
          </p>
          <p className="mt-4 text-xs font-semibold text-muted">What do you need help with? *</p>
          <div className="mt-2">
            <Select
              value={topic}
              onChange={(e) => {
                const v = e.target.value;
                setTopic(v);
                if (v !== "Other") setOtherTopicDetail("");
              }}
            >
              <option value="">Select a topic</option>
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          {isOther ? (
            <div className="mt-4">
              <Field label="Describe your topic *">
                <input
                  type="text"
                  value={otherTopicDetail}
                  onChange={(e) => setOtherTopicDetail(e.target.value)}
                  placeholder="Type what you need help with"
                  className={inputCls}
                />
              </Field>
            </div>
          ) : null}
        </div>

        <div>
          <h2 className="text-base font-bold text-foreground">Your contact & message</h2>
          <p className="mt-1 text-sm text-muted">
            We will reply to the email you provide{propertyTitle ? ` about ${propertyTitle}` : ""}.
          </p>
          <div className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name *">
                <input type="text" placeholder="Jane Smith" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Email *">
                <input type="email" placeholder="jane@email.com" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </div>
            <Field label="Phone">
              <input type="tel" placeholder="(206) 555-0100" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Message *">
              <textarea rows={4} placeholder="Tell us more so we can help…" className={`${inputCls} resize-none`} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <SmsConsentCheckbox checked={smsConsent} onChange={setSmsConsent} inputId="message-sms-consent" />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSend}
        disabled={submitting}
        data-attr="property-lead-message-send"
        className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(0,122,255,0.28)] transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: "linear-gradient(135deg, var(--primary), var(--primary-alt))" }}
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
    <div data-wizard-field={fieldKey}>
      <p className="mb-1.5 text-xs font-semibold text-muted">{label}</p>
      {children}
      {error ? <p className="mt-1 text-xs font-medium text-red-600">{error}</p> : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-border bg-accent/30 px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted/70 focus:border-primary focus:bg-card focus:ring-2 focus:ring-primary/15 hover:border-border";

function CheckSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
