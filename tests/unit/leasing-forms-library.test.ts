import { describe, expect, it } from "vitest";
import {
  applyPropertyFormPicks,
  duplicateLibraryForm,
  filterLibraryForms,
  libraryFormFacts,
  libraryFormUseCount,
  librarySubmissionShell,
  libraryFromEditedSubmission,
  normalizeLeasingFormsLibrary,
  propertyFormPicks,
  stripServerOwnedFromLibrary,
  syncLibraryFormIntoProperty,
  upsertLibraryForm,
  type LeasingFormsLibrary,
} from "@/lib/leasing-forms-library";
import { applicationBeforeTourRequired } from "@/lib/application-before-tour-policy";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  publishApplicationTemplateQuestionDraft,
  readPropertyApplicationTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, readPropertyLeaseTemplates } from "@/lib/property-lease-templates";

const SLICE = { disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "standard" as const };

function draftApplication(label: string, tourOrder?: PropertyApplicationTemplate["tourOrder"]): PropertyApplicationTemplate {
  return {
    ...createPropertyApplicationTemplate({ kind: "long-term", label }),
    tourOrder,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(SLICE),
  };
}

function libraryWith(): LeasingFormsLibrary {
  return {
    applications: [draftApplication("Standard application", "before_tour"), draftApplication("Quick application", "after_tour")],
    leases: [createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease", source: "axis_default" })],
  };
}

/** What the server does when a property copy is published: it stamps `publishedQuestionConfig`. */
function publishAll(sub: ReturnType<typeof createDefaultListingSubmission>) {
  const templates = readPropertyApplicationTemplates(sub).map((template) =>
    template.draftQuestionConfig ? { ...template, ...publishApplicationTemplateQuestionDraft(template) } : template,
  );
  return { ...sub, propertyApplicationTemplates: templates };
}

describe("library storage", () => {
  it("reads anything as a library and never keeps publication or the source receipt", () => {
    expect(normalizeLeasingFormsLibrary(null)).toEqual({ applications: [], leases: [] });
    expect(normalizeLeasingFormsLibrary("nope")).toEqual({ applications: [], leases: [] });
    const form = draftApplication("Standard application");
    const published = {
      ...form,
      publishedQuestionConfig: { ...form.draftQuestionConfig!, version: 3 },
      publishedQuestionConfigVersions: [{ ...form.draftQuestionConfig!, version: 2 }],
      draftQuestionConfig: { ...form.draftQuestionConfig!, importProvenance: { sourcePath: "u1/application-import/x/a.pdf" } },
    };
    const stored = stripServerOwnedFromLibrary(normalizeLeasingFormsLibrary({ applications: [published, published], leases: [] }));
    expect(stored.applications).toHaveLength(1);
    expect(stored.applications[0]!.publishedQuestionConfig).toBeUndefined();
    expect(stored.applications[0]!.publishedQuestionConfigVersions).toBeUndefined();
    expect(stored.applications[0]!.draftQuestionConfig?.importProvenance).toBeUndefined();
  });

  it("an editor opened on the library hands back exactly the library", () => {
    const library = libraryWith();
    const shell = librarySubmissionShell(createDefaultListingSubmission(), library);
    const back = libraryFromEditedSubmission(shell);
    expect(back.applications.map((form) => form.id)).toEqual(library.applications.map((form) => form.id));
    expect(back.leases.map((form) => form.id)).toEqual(library.leases.map((form) => form.id));
  });

  it("duplicate gets a new id and name and no publication", () => {
    const [form] = libraryWith().applications;
    const copy = duplicateLibraryForm("application", form!) as PropertyApplicationTemplate;
    expect(copy.id).not.toBe(form!.id);
    expect(copy.label).toBe("Standard application copy");
    expect(copy.tourOrder).toBe("before_tour");
    expect(copy.publishedQuestionConfig).toBeUndefined();
  });
});

describe("the Forms page rows", () => {
  it("states where a form started, how many questions, the lease type, the tour order and the properties using it", () => {
    const library = libraryWith();
    const facts = libraryFormFacts("application", library.applications[0]!, 2);
    expect(facts.startSource).toBe("PropLane standard");
    expect(facts.questionCount).toBeGreaterThan(5);
    expect(facts.leaseTypes).toEqual(["Long-term"]);
    expect(facts.tourOrder).toBe("Before the tour");
    expect(facts.propertyCount).toBe(2);
    expect(libraryFormFacts("application", library.applications[1]!, 0).tourOrder).toBe("After the tour");
    expect(libraryFormFacts("application", draftApplication("None"), 0).tourOrder).toBe("Use the workspace setting");
    const lease = libraryFormFacts("lease", library.leases[0]!, 1);
    expect(lease.tourOrder).toBeNull();
    expect(lease.startSource).toBe("PropLane standard");
  });

  it("names an uploaded source and filters by name", () => {
    const upload = { ...draftApplication("Intake"), draftQuestionConfig: { ...applicationTemplateQuestionConfigFromSlice(SLICE), importProvenance: { sourceName: "Intake.pdf" } } };
    expect(libraryFormFacts("application", upload, 0).startSource).toBe("Uploaded Intake.pdf");
    const library = libraryWith();
    expect(filterLibraryForms("application", library.applications, "quick").map((form) => form.label)).toEqual(["Quick application"]);
    expect(filterLibraryForms("application", library.applications, "").length).toBe(2);
  });
});

describe("tourOrder round-trips on the form", () => {
  it("is kept through the library, a property pick, and a later edit pushed to that property", () => {
    let library = libraryWith();
    const [standard] = library.applications;
    expect(standard!.tourOrder).toBe("before_tour");

    const picked = applyPropertyFormPicks(createDefaultListingSubmission(), "application", new Set([standard!.id]), library);
    const copy = readPropertyApplicationTemplates(picked.sub).find((form) => form.libraryFormId === standard!.id)!;
    expect(copy.tourOrder).toBe("before_tour");

    library = upsertLibraryForm(library, "application", { ...standard!, tourOrder: "after_tour" });
    const synced = syncLibraryFormIntoProperty(picked.sub, "application", library.applications[0]!);
    const updated = readPropertyApplicationTemplates(synced).find((form) => form.id === copy.id)!;
    expect(updated.tourOrder).toBe("after_tour");
  });
});

describe("a property's picks drive which forms its listing uses", () => {
  it("adds a linked copy to the property's own list for each pick, and nothing else", () => {
    const library = libraryWith();
    const own = draftApplication("Property's own form");
    const base = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [own], propertyApplicationTemplatesExplicit: true };
    const applied = applyPropertyFormPicks(base, "application", new Set([library.applications[0]!.id]), library);
    const templates = readPropertyApplicationTemplates(applied.sub);
    expect(templates.map((form) => form.label)).toEqual(["Property's own form", "Standard application"]);
    expect(templates[1]!.libraryFormId).toBe(library.applications[0]!.id);
    expect(templates[1]!.id).not.toBe(library.applications[0]!.id);
    expect(applied.added).toBe(1);
    expect(applied.addedApplicationIds).toEqual([templates[1]!.id]);
    expect(propertyFormPicks(applied.sub, "application")).toEqual(new Set([library.applications[0]!.id]));
    // Picking again changes nothing; the property's own form is never touched.
    const again = applyPropertyFormPicks(applied.sub, "application", new Set([library.applications[0]!.id]), library);
    expect(again.added).toBe(0);
    expect(readPropertyApplicationTemplates(again.sub)).toHaveLength(2);
  });

  it("un-picking removes only the linked copy", () => {
    const library = libraryWith();
    const own = draftApplication("Property's own form");
    const base = { ...createDefaultListingSubmission(), propertyApplicationTemplates: [own], propertyApplicationTemplatesExplicit: true };
    const both = applyPropertyFormPicks(base, "application", new Set(library.applications.map((form) => form.id)), library);
    const one = applyPropertyFormPicks(both.sub, "application", new Set([library.applications[1]!.id]), library);
    expect(one.removed).toBe(1);
    expect(readPropertyApplicationTemplates(one.sub).map((form) => form.label)).toEqual(["Property's own form", "Quick application"]);
  });

  it("lease picks fill the property's lease list", () => {
    const library = libraryWith();
    const applied = applyPropertyFormPicks(createDefaultListingSubmission(), "lease", new Set([library.leases[0]!.id]), library);
    const leases = readPropertyLeaseTemplates(applied.sub);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.libraryFormId).toBe(library.leases[0]!.id);
    expect(leases[0]!.offered).toBe(true);
  });

  it("a picked application's lease link follows onto the property's copy of that lease", () => {
    const library = libraryWith();
    const linked = { ...library.applications[0]!, linkedLeaseTemplateId: library.leases[0]!.id };
    const withLink = { ...library, applications: [linked, library.applications[1]!] };
    const leasesFirst = applyPropertyFormPicks(createDefaultListingSubmission(), "lease", new Set([library.leases[0]!.id]), withLink);
    const both = applyPropertyFormPicks(leasesFirst.sub, "application", new Set([linked.id]), withLink);
    const copy = readPropertyApplicationTemplates(both.sub).find((form) => form.libraryFormId === linked.id)!;
    const leaseCopy = readPropertyLeaseTemplates(both.sub)[0]!;
    expect(copy.linkedLeaseTemplateId).toBe(leaseCopy.id);
    // Without the lease picked, the link cannot point at a lease the property does not have.
    const alone = applyPropertyFormPicks(createDefaultListingSubmission(), "application", new Set([linked.id]), withLink);
    expect(readPropertyApplicationTemplates(alone.sub)[0]!.linkedLeaseTemplateId ?? null).toBeNull();
  });

  it("the picked forms' tour order is what gates a tour at that property", () => {
    const library = libraryWith();
    const beforeTour = applyPropertyFormPicks(createDefaultListingSubmission(), "application", new Set([library.applications[0]!.id]), library);
    // A copy is a draft until the server publishes it, so it does not gate anything yet.
    expect(applicationBeforeTourRequired("not_needed", readPropertyApplicationTemplates(beforeTour.sub))).toBe(false);
    const live = readPropertyApplicationTemplates(publishAll(beforeTour.sub));
    expect(applicationBeforeTourRequired("not_needed", live)).toBe(true);
    const afterTour = applyPropertyFormPicks(createDefaultListingSubmission(), "application", new Set([library.applications[1]!.id]), library);
    const liveAfter = readPropertyApplicationTemplates(publishAll(afterTour.sub));
    expect(applicationBeforeTourRequired("required", liveAfter)).toBe(false);
  });

  it("counts the properties using a form", () => {
    const library = libraryWith();
    const id = library.applications[0]!.id;
    const used = applyPropertyFormPicks(createDefaultListingSubmission(), "application", new Set([id]), library).sub;
    expect(libraryFormUseCount(id, "application", [used, createDefaultListingSubmission(), used])).toBe(2);
    expect(libraryFormUseCount(id, "lease", [used])).toBe(0);
  });
});
