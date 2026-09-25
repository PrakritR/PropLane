// @vitest-environment jsdom
//
// PUBLIC apply flow — draft resume after a real page reload. The in-memory
// wizard draft dies on reload, so the wizard's public resume effect restores
// the in-progress application from the server: a guest presents the axis id +
// freshest resident-setup token kept in sessionStorage (capability read via
// POST /api/portal/application-resume); a signed-in user falls back to the
// email-scoped GET ?scope=self. Only the axis id and token ever touch disk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  clearRentalWizardDraft,
  loadRentalWizardDraft,
  loadRentalWizardDraftAxisId,
} from "@/lib/rental-application/drafts";
import type { MockProperty } from "@/data/types";
import { settlePendingApplicationRowUpserts } from "@/lib/manager-applications-storage";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";

const PID = "mgr-resume-flat";
const PID_B = "mgr-resume-second";
const AXIS_ID = "PROPLANE-RESUME01";
const TOKEN = "guest-resume-token-123";

let searchParams = new URLSearchParams({ propertyId: PID });

vi.mock("next/navigation", () => ({
  usePathname: () => "/rent/apply",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";

function seedListing(secondSubmission?: ReturnType<typeof createDefaultListingSubmission>): void {
  const sub = createDefaultListingSubmission();
  const property: MockProperty = {
    id: PID,
    title: "Resume Flat",
    tagline: "Test",
    address: "1 Resume St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Resume Flat",
    unitLabel: "Unit 1",
    adminPublishLive: true,
    managerUserId: "mgr-resume-owner",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([
    property,
    {
      ...property,
      id: PID_B,
      title: "Second Flat",
      address: "2 Resume St, Seattle, WA",
      listingSubmission: normalizeManagerListingSubmissionV1(secondSubmission ?? sub),
    },
  ], { silent: true });
}

function publishedTemplateSubmission(templateId: string, version: number) {
  const submission = createDefaultListingSubmission();
  const config = {
    version,
    disabledStandardApplicationKeys: [],
    customApplicationFields: [],
    applicationConfigMode: "standard" as const,
    questionDisplayOrder: [],
  };
  submission.propertyApplicationTemplates = [{
    id: templateId,
    kind: "long-term",
    label: "Published application",
    formVariant: "standard",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    draftQuestionConfig: config,
    publishedQuestionConfig: config,
    ...(version > 1 ? { publishedQuestionConfigVersions: [{ ...config, version: 1 }] } : {}),
  }];
  return submission;
}

function serverRow(): DemoApplicantRow {
  return {
    id: AXIS_ID,
    name: "Riley Guest",
    email: "riley.guest@example.com",
    property: "Resume Flat",
    propertyId: PID,
    stage: "In progress",
    bucket: "pending",
    detail: "Started",
    application: {
      propertyId: PID,
      email: "riley.guest@example.com",
      fullLegalName: "Riley Guest",
      wizardStep: 4,
      wizardMaxStepReached: 4,
    } as DemoApplicantRow["application"],
  };
}

const fetchCalls: { url: string; body: string | null }[] = [];

function stubFetch(handlers: { resumeStatus?: number; resumeRow?: DemoApplicantRow | null; resumeRows?: Record<string, DemoApplicantRow>; selfRows?: DemoApplicantRow[]; selfResponse?: () => Promise<Response>; resumeResponse?: (id: string) => Promise<Response> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : null });
      if (url.includes("/api/portal/application-resume")) {
        const id = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: string }).id : undefined;
        if (handlers.resumeResponse) return handlers.resumeResponse(id ?? "");
        const resumeRow = (id && handlers.resumeRows?.[id]) || handlers.resumeRow;
        const status = handlers.resumeStatus ?? (resumeRow ? 200 : 403);
        return new Response(
          JSON.stringify(resumeRow ? { row: resumeRow } : { error: "Not allowed." }),
          { status },
        );
      }
      if (url.includes("/api/manager-applications") && !init?.method) {
        if (handlers.selfResponse) return handlers.selfResponse();
        return new Response(JSON.stringify({ rows: handlers.selfRows ?? [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200 });
    }),
  );
}

async function chooseProperty(title: string) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(title) })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mountWizard() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RentalApplicationWizard showToast={() => {}} mode="public" exitPath="/rent/browse" />);
  });
  // Let the async resume reads resolve and their state updates flush.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  // jsdom defaults to "/", which `isDemoModeActive()` treats as the public demo
  // surface — the real apply page lives at /rent/apply.
  window.history.replaceState(null, "", `/rent/apply?propertyId=${PID}`);
  seedListing();
  searchParams = new URLSearchParams({ propertyId: PID });
  fetchCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearRentalWizardDraft();
  window.sessionStorage.clear();
});

describe("public apply — resume after reload", () => {
  it("restores a guest's in-progress draft via the axis id + setup token kept in sessionStorage", async () => {
    // What a pre-reload session left behind: ONLY the id and the token.
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", AXIS_ID);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${AXIS_ID}`, TOKEN);
    stubFetch({ resumeRow: serverRow() });

    await mountWizard();

    const resumeCall = fetchCalls.find((c) => c.url.includes("/api/portal/application-resume"));
    expect(resumeCall).toBeDefined();
    expect(JSON.parse(resumeCall!.body ?? "{}")).toEqual({ id: AXIS_ID, token: TOKEN });

    expect(loadRentalWizardDraftAxisId()).toBe(AXIS_ID);
    const draft = loadRentalWizardDraft();
    expect(draft?.fullLegalName).toBe("Riley Guest");
    expect(draft?.email).toBe("riley.guest@example.com");
    expect(draft?.propertyId).toBe(PID);
  });

  it("falls back to the signed-in email-scoped read (?scope=self) when no guest token is stored", async () => {
    stubFetch({ selfRows: [serverRow()] });

    await mountWizard();

    expect(fetchCalls.some((c) => c.url.includes("/api/portal/application-resume"))).toBe(false);
    expect(fetchCalls.some((c) => c.url.includes("/api/manager-applications?scope=self"))).toBe(true);
    expect(loadRentalWizardDraftAxisId()).toBe(AXIS_ID);
    expect(loadRentalWizardDraft()?.fullLegalName).toBe("Riley Guest");
  });

  it("never restores a draft for a DIFFERENT property than the one this request targets", async () => {
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", AXIS_ID);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${AXIS_ID}`, TOKEN);
    const foreign = serverRow();
    foreign.propertyId = "mgr-some-other-listing";
    (foreign.application as { propertyId?: string }).propertyId = "mgr-some-other-listing";
    stubFetch({ resumeRow: foreign });

    await mountWizard();

    expect(loadRentalWizardDraftAxisId()).toBeNull();
    expect(loadRentalWizardDraft()?.fullLegalName ?? "").not.toBe("Riley Guest");
  });

  it("restores nothing when both reads come back empty (a genuinely fresh application)", async () => {
    stubFetch({ selfRows: [] });

    await mountWizard();

    expect(loadRentalWizardDraftAxisId()).toBeNull();
  });

  it("returns to a saved v1 standard variant after reloading a v2 short-term draft", async () => {
    const standardId = "PROPLANE-STANDARD1";
    const shortId = "PROPLANE-SHORT001";
    const standard = serverRow();
    standard.id = standardId;
    standard.application = { ...standard.application, rentalType: "standard", leaseTerm: "Long-term", applicationTemplateId: "template-standard", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "standard_key", label: "Question", type: "text", value: "saved v1 answer" }] } as DemoApplicantRow["application"];
    const short = serverRow();
    short.id = shortId;
    short.application = { ...short.application, rentalType: "short_term", leaseTerm: "Short-Term Stay", applicationTemplateId: "template-short", applicationTemplateVersion: 2, customFieldAnswers: [{ key: "short_key", label: "Question", type: "text", value: "saved v2 answer" }], wizardStep: 3 } as DemoApplicantRow["application"];
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", shortId);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${shortId}`, TOKEN);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${standardId}`, TOKEN);
    window.sessionStorage.setItem("axis:rental-application:variant-axis-ids:v1", JSON.stringify({ [`${PID}:standard`]: standardId, [`${PID}:short_term`]: shortId }));
    stubFetch({ resumeRows: { [standardId]: standard, [shortId]: short } });

    await mountWizard();
    expect(loadRentalWizardDraftAxisId()).toBe(shortId);
    fireEvent.click(screen.getByRole("button", { name: "Select lease length" }));
    await act(async () => {
      const option = screen.getByRole("option", { name: "Long-term" });
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchCalls.some((call) => call.url.includes("/api/portal/application-resume") && JSON.parse(call.body ?? "{}").id === standardId)).toBe(true);
    expect(loadRentalWizardDraftAxisId()).toBe(standardId);
    expect(loadRentalWizardDraft()).toMatchObject({ applicationTemplateVersion: 1, customFieldAnswers: [{ key: "standard_key", value: "saved v1 answer" }] });
    expect(window.sessionStorage.getItem("axis:rental-application:variant-axis-ids:v1")).not.toContain("saved v1 answer");
  });

  it("restores each property's saved answer and pin before writing its row", async () => {
    const currentB = publishedTemplateSubmission("template-b", 2);
    seedListing(currentB);
    const a = serverRow();
    a.application = { ...a.application, wizardStep: 3, rentalType: "standard", applicationTemplateId: "template-a", applicationTemplateVersion: 2, customFieldAnswers: [{ key: "a", label: "A", type: "text", value: "answer A" }] } as DemoApplicantRow["application"];
    const b = serverRow();
    b.id = "PROPLANE-SECOND1";
    b.propertyId = PID_B;
    b.property = "Second Flat";
    b.application = { ...b.application, wizardStep: 3, propertyId: PID_B, rentalType: "standard", applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", label: "B", type: "text", value: "answer B" }] } as DemoApplicantRow["application"];
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", a.id);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${a.id}`, TOKEN);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${b.id}`, TOKEN);
    window.sessionStorage.setItem("axis:rental-application:variant-axis-ids:v1", JSON.stringify({ [`${PID}:standard`]: a.id, [`${PID_B}:standard`]: b.id }));
    searchParams = new URLSearchParams({ ids: `${PID},${PID_B}` });
    window.history.replaceState(null, "", `/rent/apply?${searchParams}`);
    stubFetch({ resumeRows: { [a.id]: a, [b.id]: b } });

    await mountWizard();
    expect(loadRentalWizardDraft()).toMatchObject({ applicationTemplateId: "template-a", applicationTemplateVersion: 2 });
    await chooseProperty("Second Flat");
    expect(loadRentalWizardDraftAxisId()).toBe(b.id);
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID_B, applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", value: "answer B" }] });
    expect(applicationConfigForApplicant(currentB, "standard", "template-b", 1).templateVersion).toBe(1);
    await chooseProperty("Resume Flat");
    expect(loadRentalWizardDraftAxisId()).toBe(a.id);
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID, applicationTemplateId: "template-a", applicationTemplateVersion: 2, customFieldAnswers: [{ key: "a", value: "answer A" }] });
  });

  it("pins a fresh property's current template before its delayed empty lookup can autosave", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(document.body);
    const a = serverRow();
    a.application = {
      ...a.application,
      wizardStep: 3,
      rentalType: "standard",
      applicationTemplateId: "template-a",
      applicationTemplateVersion: 1,
    } as DemoApplicantRow["application"];
    seedListing(publishedTemplateSubmission("template-b-current", 2));
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", a.id);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${a.id}`, TOKEN);
    window.sessionStorage.setItem("axis:rental-application:variant-axis-ids:v1", JSON.stringify({ [`${PID}:standard`]: a.id }));
    searchParams = new URLSearchParams({ ids: `${PID},${PID_B}` });
    window.history.replaceState(null, "", `/rent/apply?${searchParams}`);

    let releaseLookup: ((response: Response) => void) | undefined;
    stubFetch({
      resumeResponse: async (id) => new Response(JSON.stringify({ row: id === a.id ? a : null }), { status: id === a.id ? 200 : 404 }),
      selfResponse: async () => new Promise<Response>((resolve) => { releaseLookup = resolve; }),
    });

    await mountWizard();
    await chooseProperty("Second Flat");
    expect(screen.getByText("Restoring your saved application…")).toBeTruthy();
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID, applicationTemplateId: "template-a" });

    await act(async () => {
      releaseLookup?.(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadRentalWizardDraft()).toMatchObject({
      propertyId: PID_B,
      applicationTemplateId: "template-b-current",
      applicationTemplateVersion: 2,
      customFieldAnswers: [],
    });
    const freshAxisId = loadRentalWizardDraftAxisId();
    expect(freshAxisId).toBeTruthy();
    await act(async () => { await settlePendingApplicationRowUpserts(freshAxisId!); });
    const freshWrite = fetchCalls.find((call) => {
      if (call.url !== "/api/manager-applications" || !call.body) return false;
      const payload = JSON.parse(call.body) as { row?: DemoApplicantRow };
      return payload.row?.id === freshAxisId && payload.row.application?.propertyId === PID_B;
    });
    expect(freshWrite).toBeDefined();
    expect((JSON.parse(freshWrite!.body!) as { row: DemoApplicantRow }).row.application).toMatchObject({
      propertyId: PID_B,
      applicationTemplateId: "template-b-current",
      applicationTemplateVersion: 2,
    });

  });

  it("ignores a delayed B response after returning to A and retries a failed B lookup without writing B", async () => {
    const a = serverRow();
    a.application = { ...a.application, wizardStep: 3, rentalType: "standard", applicationTemplateId: "template-a", applicationTemplateVersion: 2, customFieldAnswers: [{ key: "a", label: "A", type: "text", value: "answer A" }] } as DemoApplicantRow["application"];
    const b = serverRow();
    b.id = "PROPLANE-SECOND2";
    b.propertyId = PID_B;
    b.property = "Second Flat";
    b.application = { ...b.application, wizardStep: 3, propertyId: PID_B, rentalType: "standard", applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", label: "B", type: "text", value: "answer B" }] } as DemoApplicantRow["application"];
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", a.id);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${a.id}`, TOKEN);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${b.id}`, TOKEN);
    window.sessionStorage.setItem("axis:rental-application:variant-axis-ids:v1", JSON.stringify({ [`${PID}:standard`]: a.id, [`${PID_B}:standard`]: b.id }));
    searchParams = new URLSearchParams({ ids: `${PID},${PID_B}` });
    window.history.replaceState(null, "", `/rent/apply?${searchParams}`);
    let releaseB: ((response: Response) => void) | undefined;
    let bCalls = 0;
    stubFetch({ resumeResponse: async (id) => {
      if (id === b.id) {
        bCalls += 1;
        if (bCalls === 1) return new Promise<Response>((resolve) => { releaseB = resolve; });
        if (bCalls === 2) return new Response(JSON.stringify({ error: "temporary" }), { status: 500 });
        return new Response(JSON.stringify({ row: b }), { status: 200 });
      }
      return new Response(JSON.stringify({ row: a }), { status: 200 });
    } });

    await mountWizard();
    await chooseProperty("Second Flat");
    expect(screen.getByText("Restoring your saved application…")).toBeTruthy();
    await chooseProperty("Resume Flat");
    await act(async () => { releaseB?.(new Response(JSON.stringify({ row: b }), { status: 200 })); await Promise.resolve(); });
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID, applicationTemplateId: "template-a", customFieldAnswers: [{ key: "a", value: "answer A" }] });
    await chooseProperty("Second Flat");
    expect(screen.getByText(/could not be restored/i)).toBeTruthy();
    expect(fetchCalls.filter((call) => call.url.includes("/api/manager-applications") && call.body?.includes('"propertyId":"mgr-resume-second"'))).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry restore" })); await Promise.resolve(); await Promise.resolve(); });
    expect(bCalls).toBe(3);
    expect(loadRentalWizardDraftAxisId()).toBe(b.id);
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID_B, applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", value: "answer B" }] });
  });

  it("restores a saved target when the apply URL changes properties", async () => {
    const a = serverRow();
    a.application = { ...a.application, rentalType: "standard", applicationTemplateId: "template-a", applicationTemplateVersion: 2 } as DemoApplicantRow["application"];
    const b = serverRow();
    b.id = "PROPLANE-SECOND3";
    b.propertyId = PID_B;
    b.property = "Second Flat";
    b.application = { ...b.application, propertyId: PID_B, rentalType: "standard", applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", label: "B", type: "text", value: "saved B" }] } as DemoApplicantRow["application"];
    window.sessionStorage.setItem("axis:rental-application:public-resume-axis-id:v1", a.id);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${a.id}`, TOKEN);
    window.sessionStorage.setItem(`axis.applicationSetupToken.${b.id}`, TOKEN);
    window.sessionStorage.setItem("axis:rental-application:variant-axis-ids:v1", JSON.stringify({ [`${PID}:standard`]: a.id, [`${PID_B}:standard`]: b.id }));
    stubFetch({ resumeRows: { [a.id]: a, [b.id]: b } });
    const view = await mountWizard();
    searchParams = new URLSearchParams({ propertyId: PID_B });
    window.history.replaceState(null, "", `/rent/apply?${searchParams}`);
    await act(async () => {
      view.rerender(<RentalApplicationWizard showToast={() => {}} mode="public" exitPath="/rent/browse" />);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(loadRentalWizardDraftAxisId()).toBe(b.id);
    expect(loadRentalWizardDraft()).toMatchObject({ propertyId: PID_B, applicationTemplateId: "template-b", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "b", value: "saved B" }] });
  });
});

describe("manager application preview", () => {
  it("renders the current unsaved question draft in the full wizard", async () => {
    stubFetch({ selfRows: [] });
    const base = createDefaultListingSubmission();
    const draft = normalizeManagerListingSubmissionV1({
      ...base,
      applicationConfigMode: "custom",
      customApplicationFields: [{
        id: "preview-question",
        key: "preview_question",
        label: "What should the manager know about your move?",
        type: "text",
        required: true,
        section: "household",
        options: [],
      }],
    });
    await act(async () => {
      render(
        <RentalApplicationWizard
          showToast={() => {}}
          mode="manager"
          layout="embedded"
          linkedPropertyId={PID}
          templatePreview
          templatePreviewSubmission={draft}
        />,
      );
    });
    expect(screen.getByText("What should the manager know about your move?", { exact: false })).toBeTruthy();
    expect(fetchCalls.some((call) => call.url.includes("/api/manager-applications"))).toBe(false);
  });
});
