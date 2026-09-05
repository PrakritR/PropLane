import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  persistApplicationConfigToPropertyIds,
  persistLeaseConfigToPropertyIds,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import * as propertyPipeline from "@/lib/demo-property-pipeline";
import * as adminInventory from "@/lib/demo-admin-property-inventory";

describe("persistLeaseConfigToPropertyIds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the same lease fields to each listed property", () => {
    const subA = {
      ...createDefaultListingSubmission(),
      buildingName: "A",
      leaseConfigMode: "standard" as const,
    };
    const subB = {
      ...createDefaultListingSubmission(),
      buildingName: "B",
      leaseConfigMode: "standard" as const,
    };

    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([
      {
        id: "prop-a",
        title: "A",
        tagline: "",
        address: "1 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2000",
        available: "Now",
        petFriendly: true,
        buildingId: "b1",
        buildingName: "A",
        unitLabel: "1",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "mgr-1",
        adminPublishLive: true,
        listingSubmission: subA,
      },
      {
        id: "prop-b",
        title: "B",
        tagline: "",
        address: "2 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2100",
        available: "Now",
        petFriendly: false,
        buildingId: "b2",
        buildingName: "B",
        unitLabel: "2",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "mgr-1",
        adminPublishLive: true,
        listingSubmission: subB,
      },
    ]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);

    const updateListing = vi.spyOn(propertyPipeline, "updateExtraListingFromSubmission").mockReturnValue(true);

    const leaseFields = {
      leaseConfigMode: "custom" as const,
      leaseCustomKind: "terms" as const,
      customLeaseTerms: "No smoking indoors.",
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
    };

    const result = persistLeaseConfigToPropertyIds("mgr-1", ["prop-a", "prop-b"], leaseFields);

    expect(result).toEqual({ saved: 2, failed: 0 });
    expect(updateListing).toHaveBeenCalledTimes(2);
    expect(updateListing).toHaveBeenCalledWith(
      "prop-a",
      "mgr-1",
      expect.objectContaining({ leaseConfigMode: "custom", customLeaseTerms: "No smoking indoors." }),
    );
    expect(updateListing).toHaveBeenCalledWith(
      "prop-b",
      "mgr-1",
      expect.objectContaining({ leaseConfigMode: "custom", customLeaseTerms: "No smoking indoors." }),
    );
  });

  it("counts missing properties as failed", () => {
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
    vi.spyOn(adminInventory, "updateRequestChangeProperty").mockReturnValue(true);

    const result = persistLeaseConfigToPropertyIds("mgr-1", ["missing"], {
      leaseConfigMode: "standard",
      leaseCustomKind: "terms",
      customLeaseTerms: "",
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
    });

    expect(result).toEqual({ saved: 0, failed: 1 });
    expect(resolveManagerListingSubmissionForPropertyId("mgr-1", "missing")).toBeNull();
  });

  it("updates only the requested stay-kind template for every selected property", () => {
    const longTemplate = {
      id: "long-v1",
      kind: "long-term" as const,
      label: "Long-term lease",
      listingSeedKey: "primary" as const,
      leaseConfigMode: "custom" as const,
      leaseCustomKind: "document" as const,
      customLeaseTerms: "",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/long.pdf",
      leaseTemplateDocName: "Long-term.pdf",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const shortTemplate = {
      ...longTemplate,
      id: "short-v1",
      kind: "short-term" as const,
      label: "Short-term agreement",
      listingSeedKey: "short-term" as const,
      leaseConfigMode: "standard" as const,
      leaseCustomKind: "terms" as const,
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
    };
    const sub = { ...createDefaultListingSubmission(), propertyLeaseTemplates: [longTemplate, shortTemplate] };
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([
      {
        id: "prop-a", title: "A", tagline: "", address: "1 Main", zip: "98101", neighborhood: "Downtown",
        beds: 2, baths: 1, rentLabel: "$2000", available: "Now", petFriendly: true, buildingId: "b1",
        buildingName: "A", unitLabel: "1", managerUserId: "mgr-1", adminPublishLive: true, listingSubmission: sub,
      },
      {
        id: "prop-b", title: "B", tagline: "", address: "2 Main", zip: "98101", neighborhood: "Downtown",
        beds: 2, baths: 1, rentLabel: "$2000", available: "Now", petFriendly: true, buildingId: "b2",
        buildingName: "B", unitLabel: "1", managerUserId: "mgr-1", adminPublishLive: true, listingSubmission: sub,
      },
    ]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
    const updateListing = vi.spyOn(propertyPipeline, "updateExtraListingFromSubmission").mockReturnValue(true);

    const result = persistLeaseConfigToPropertyIds("mgr-1", ["prop-a", "prop-b"], {
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
      customLeaseTerms: "",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/short.pdf",
      leaseTemplateDocName: "Short-term.pdf",
    }, "short-term");

    expect(result).toEqual({ saved: 2, failed: 0 });
    for (const [, , saved] of updateListing.mock.calls) {
      const templates = saved.propertyLeaseTemplates ?? [];
      expect(templates.find((template) => template.listingSeedKey === "primary")).toMatchObject({
        leaseTemplateDocName: "Long-term.pdf",
      });
      expect(templates.find((template) => template.listingSeedKey === "short-term")).toMatchObject({
        leaseTemplateDocName: "Short-term.pdf",
      });
    }
  });
});

describe("persistApplicationConfigToPropertyIds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the same application config fields to each listed property", () => {
    const subA = {
      ...createDefaultListingSubmission(),
      buildingName: "A",
      applicationConfigMode: "standard" as const,
    };
    const subB = {
      ...createDefaultListingSubmission(),
      buildingName: "B",
      applicationConfigMode: "standard" as const,
    };

    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([
      {
        id: "prop-a",
        title: "A",
        tagline: "",
        address: "1 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2000",
        available: "Now",
        petFriendly: true,
        buildingId: "b1",
        buildingName: "A",
        unitLabel: "1",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "mgr-1",
        adminPublishLive: true,
        listingSubmission: subA,
      },
      {
        id: "prop-b",
        title: "B",
        tagline: "",
        address: "2 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2100",
        available: "Now",
        petFriendly: false,
        buildingId: "b2",
        buildingName: "B",
        unitLabel: "2",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "mgr-1",
        adminPublishLive: true,
        listingSubmission: subB,
      },
    ]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);

    const updateListing = vi.spyOn(propertyPipeline, "updateExtraListingFromSubmission").mockReturnValue(true);

    const configFields = {
      disabledStandardApplicationKeys: ["personal:SSN"],
      customApplicationFields: [
        {
          id: "custom-1",
          key: "custom_1",
          label: "Do you smoke?",
          type: "select" as const,
          required: true,
          options: ["Yes", "No"],
          section: "additional" as const,
        },
      ],
      applicationConfigMode: "custom" as const,
    };

    const result = persistApplicationConfigToPropertyIds("mgr-1", ["prop-a", "prop-b"], configFields);

    expect(result).toEqual({ saved: 2, failed: 0 });
    expect(updateListing).toHaveBeenCalledTimes(2);
    expect(updateListing).toHaveBeenCalledWith(
      "prop-a",
      "mgr-1",
      expect.objectContaining({
        applicationConfigMode: "custom",
        customApplicationFields: configFields.customApplicationFields,
      }),
    );
    expect(updateListing).toHaveBeenCalledWith(
      "prop-b",
      "mgr-1",
      expect.objectContaining({
        applicationConfigMode: "custom",
        customApplicationFields: configFields.customApplicationFields,
      }),
    );
  });

  it("counts missing properties as failed", () => {
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);

    const result = persistApplicationConfigToPropertyIds("mgr-1", ["missing"], {
      disabledStandardApplicationKeys: [],
      customApplicationFields: [],
      applicationConfigMode: "standard",
    });

    expect(result).toEqual({ saved: 0, failed: 1 });
  });
});

describe("resolveManagerListingSubmissionForPropertyId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a co-managed listing from the owner catalog when the viewer does not own it", () => {
    const sub = { ...createDefaultListingSubmission(), buildingName: "Linked House" };
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readAllExtraListings").mockReturnValue([
      {
        id: "prop-linked",
        title: "Linked House · Unit",
        tagline: "",
        address: "1 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2000",
        available: "Now",
        petFriendly: true,
        buildingId: "b1",
        buildingName: "Linked House",
        unitLabel: "1",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "owner-1",
        adminPublishLive: true,
        listingSubmission: sub,
      },
    ]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readAllPendingManagerProperties").mockReturnValue([]);

    const hit = resolveManagerListingSubmissionForPropertyId("mgr-co", "prop-linked");
    expect(hit?.saveTarget).toEqual({ mode: "listing", saveId: "prop-linked" });
    expect(hit?.sub.buildingName).toBe("Linked House");
  });
});

describe("resolveManagerListingSubmissionForPropertyId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a co-managed listing from the owner catalog when the viewer does not own it", () => {
    const sub = { ...createDefaultListingSubmission(), buildingName: "Linked House" };
    vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readAllExtraListings").mockReturnValue([
      {
        id: "prop-linked",
        title: "Linked House · Unit",
        tagline: "",
        address: "1 Main",
        zip: "98101",
        neighborhood: "Downtown",
        beds: 2,
        baths: 1,
        rentLabel: "$2000",
        available: "Now",
        petFriendly: true,
        buildingId: "b1",
        buildingName: "Linked House",
        unitLabel: "1",
        mapLat: 0,
        mapLng: 0,
        managerUserId: "owner-1",
        adminPublishLive: true,
        listingSubmission: sub,
      },
    ]);
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
    vi.spyOn(propertyPipeline, "readAllPendingManagerProperties").mockReturnValue([]);

    const hit = resolveManagerListingSubmissionForPropertyId("mgr-co", "prop-linked");
    expect(hit?.saveTarget).toEqual({ mode: "listing", saveId: "prop-linked" });
    expect(hit?.sub.buildingName).toBe("Linked House");
  });
});
