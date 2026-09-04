// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

function installLocalStorageMock() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

describe("application-profile-prefill", () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and merges personal fields without overwriting user input", async () => {
    const {
      loadApplicationProfilePrefill,
      mergeApplicationProfilePrefill,
      saveApplicationProfilePrefill,
    } = await import("@/lib/rental-application/application-profile-prefill");

    const form = {
      ...createInitialRentalWizardState(),
      fullLegalName: "Alex Applicant",
      phone: "206-555-0100",
      email: "alex@example.com",
      currentStreet: "100 Main St",
      employer: "Acme Co",
    };
    saveApplicationProfilePrefill(form);

    const loaded = loadApplicationProfilePrefill();
    expect(loaded?.fullLegalName).toBe("Alex Applicant");
    expect(loaded?.employer).toBe("Acme Co");

    const merged = mergeApplicationProfilePrefill(
      {
        ...createInitialRentalWizardState(),
        propertyId: "mgr-new-listing",
        fullLegalName: "Typed name",
      },
      "session@example.com",
    );
    expect(merged.fullLegalName).toBe("Typed name");
    expect(merged.phone).toBe("206-555-0100");
    expect(merged.email).toBe("alex@example.com");
    expect(merged.currentStreet).toBe("100 Main St");
  });
});
