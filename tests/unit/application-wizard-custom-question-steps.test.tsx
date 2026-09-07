// @vitest-environment jsdom
//
// A manager's custom question is asked on the step its SECTION maps to, and
// `validateRentalWizardStep` demands an answer on that same step. The renderer
// only covered steps 2–9, so a required question tagged `household` (step 1) or
// `review` (step 10) was validated but never drawn: Continue did nothing at all,
// with no field to fill and no error text anywhere on screen. Household is the
// FIRST step, so that application could not be started or edited past it.
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));

// jsdom has no scrollIntoView, and the wizard scrolls to the first invalid field.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const QUESTION_LABEL = "How many cars will you park here?";

const property = {
  id: "prop-custom-questions",
  title: "Birch Flats 7",
  listingSubmission: {
    v: 1,
    customApplicationFields: [
      {
        id: "caf-household-1",
        key: "cars_parked",
        label: QUESTION_LABEL,
        type: "text",
        required: true,
        section: "household",
      },
    ],
  },
};

vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: (id: string) => (id === property.id ? property : undefined),
}));

import { ResidentApplicationEditor } from "@/components/portal/resident-application-editor";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

function applicationRow() {
  const application = {
    ...createInitialRentalWizardState(),
    propertyId: property.id,
    applyingAsGroup: "no",
    hasCosigner: "no",
  };
  // The editor takes a manager application row; only these fields matter here.
  return {
    id: "PROPLANE-TEST",
    name: "Test Applicant",
    email: "applicant@example.com",
    property: property.title,
    propertyId: property.id,
    bucket: "pending",
    stage: "Submitted",
    detail: "",
    application,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editor(row: any) {
  return (
    <ResidentApplicationEditor
      row={row}
      residentEmail="applicant@example.com"
      onCancel={() => {}}
      onSaved={() => {}}
      preserveReviewStatus
    />
  );
}

function renderEditor() {
  return render(editor(applicationRow()));
}

afterEach(cleanup);

describe("manager custom questions on the household step", () => {
  it("are asked on the step that validates them", () => {
    renderEditor();
    expect(screen.getByText("Household application")).toBeTruthy();
    expect(screen.getByText(QUESTION_LABEL, { exact: false })).toBeTruthy();
  });

  it("block Continue with a visible error rather than silently", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    // Still on step 1 — the answer is genuinely required...
    expect(screen.getByText("Household application")).toBeTruthy();
    // ...and the applicant can see why. Before the fix the question was absent,
    // so the button simply did nothing.
    expect(screen.getAllByText(QUESTION_LABEL, { exact: false }).length).toBeGreaterThan(1);
  });

  it("let Continue through once answered", () => {
    renderEditor();
    const input = document.querySelector<HTMLInputElement>('[data-wizard-field="custom:cars_parked"] input');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Signer Information")).toBeTruthy();
  });
});

describe("every section's step can draw its questions", () => {
  it("no section maps to a step the wizard never renders them on", () => {
    // The render window is derived from this catalog, so a section added with a
    // step whose body does not render `stepManagerQuestions` is the only way to
    // reopen the hole. These are the ten step bodies that render it.
    const rendered = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      expect(rendered.has(section.wizardStep)).toBe(true);
    }
  });
});

describe("a background sync must not throw away the edit in progress", () => {
  it("keeps the current step when the parent hands over an equal row object", async () => {
    // `pro-residents` rebuilds this row from storage on every applications or
    // household-charges event, so the object identity changes while the modal
    // is open. Reloading on that identity reset the form and jumped back to
    // step 1 — answers reverted and Continue read as broken.
    const { rerender } = renderEditor();
    // Let the mount-time reload settle before touching anything.
    await act(async () => {
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>('[data-wizard-field="custom:cars_parked"] input');
    fireEvent.change(input!, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("Signer Information")).toBeTruthy();

    // The reload runs in a microtask, so flush before judging.
    await act(async () => {
      rerender(editor(applicationRow()));
      await Promise.resolve();
    });
    expect(screen.getByText("Signer Information")).toBeTruthy();
  });
});
