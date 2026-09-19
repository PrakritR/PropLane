// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContactStep } from "@/components/portal/resident-wizard/step-contact";
import {
  addPersonFormIsDirty,
  alsoCreates,
  currentResidentStepOffPath,
  defaultAlsoCreate,
  emptyAddPersonForm,
  normalizeAlsoCreate,
  thingsToFinish,
} from "@/components/portal/resident-wizard/state";

afterEach(() => {
  cleanup();
});

const blankStrip = { kind: "blank" as const };

describe("Also create — current resident", () => {
  it("defaults Lease on for a current resident and nothing for a prospect", () => {
    expect(defaultAlsoCreate("resident")).toEqual(["lease"]);
    expect(defaultAlsoCreate("prospect")).toEqual([]);
    expect(emptyAddPersonForm("resident").alsoCreate).toEqual(["lease"]);
    expect(emptyAddPersonForm("prospect").alsoCreate).toEqual([]);
    expect(addPersonFormIsDirty(emptyAddPersonForm("resident"))).toBe(false);
  });

  it("snaps an empty picker back to Lease and puts Application on-path only when picked", () => {
    expect(normalizeAlsoCreate([])).toEqual(["lease"]);
    expect(normalizeAlsoCreate(["application"])).toEqual(["application"]);
    expect(normalizeAlsoCreate(["lease", "application", "bogus"])).toEqual(["lease", "application"]);

    const leaseOnly = emptyAddPersonForm("resident");
    expect(currentResidentStepOffPath("lease", leaseOnly)).toBe(false);
    expect(currentResidentStepOffPath("application", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("payments", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("documents", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("home", leaseOnly)).toBe(false);

    const withApp = { ...leaseOnly, alsoCreate: normalizeAlsoCreate(["lease", "application"]) };
    expect(alsoCreates(withApp, "application")).toBe(true);
    expect(currentResidentStepOffPath("application", withApp)).toBe(false);
    expect(addPersonFormIsDirty(withApp)).toBe(true);
  });

  it("does not ask for lease fields when Lease is unchecked", () => {
    const noLease = {
      ...emptyAddPersonForm("resident"),
      alsoCreate: normalizeAlsoCreate(["application"]),
    };
    expect(thingsToFinish(noLease).map((t) => t.step)).toEqual(["contact", "contact", "home"]);
    expect(thingsToFinish(noLease).some((t) => t.step === "lease")).toBe(false);
  });

  it("shows Also create on a current resident and not on a prospect, without the old hint sentence", () => {
    const { rerender } = render(
      <ContactStep
        form={emptyAddPersonForm("resident")}
        patch={() => {}}
        strip={blankStrip}
        onPickFile={() => {}}
        onUndoFill={() => {}}
        busy={false}
      />,
    );
    expect(screen.getByText("Also create")).toBeTruthy();
    expect(screen.queryByText(/application · lease · payments · documents/)).toBeNull();
    expect(screen.queryByText(/contact · tour/)).toBeNull();

    rerender(
      <ContactStep
        form={emptyAddPersonForm("prospect")}
        patch={() => {}}
        strip={blankStrip}
        onPickFile={() => {}}
        onUndoFill={() => {}}
        busy={false}
      />,
    );
    expect(screen.queryByText("Also create")).toBeNull();
  });
});
