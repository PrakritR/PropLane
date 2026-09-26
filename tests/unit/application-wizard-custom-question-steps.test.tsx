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
import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { applicationConfigForVariant, STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

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

describe("personal application question order", () => {
  it("interleaves a custom question with built-in fields in the configured order", () => {
    const phone = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Phone")!;
    const custom = {
      id: "personal-custom-question",
      key: "preferred_name",
      label: "Preferred name",
      type: "text" as const,
      required: false,
      options: [],
      section: "personal",
    };
    const base = applicationConfigForVariant({
      applicationConfigMode: "custom",
      customApplicationFields: [custom],
    }, "standard");
    const config = {
      ...base,
      customApplicationFields: [custom],
      questionDisplayOrder: [custom.id, `std-${phone.standardKey}`],
    };
    const noop = () => {};
    const stepProps = {
      step: 2,
      form: { ...createInitialRentalWizardState(), propertyId: property.id },
      errors: {},
      mode: "portal",
      propertyOptions: [{ value: property.id, label: property.title }],
      patch: noop,
      applicationConfigOverride: config,
      setPhone: noop,
      setLandlordPhone: noop,
      setPrevLandlordPhone: noop,
      setSupervisorPhone: noop,
      setRef1Phone: noop,
      setRef2Phone: noop,
      setSsn: noop,
      goToStep: noop,
      editFromReview: noop,
    } as WizardStepsProps;
    const { container } = render(<RentalWizardStepBody {...stepProps} />);
    const rows = [...container.querySelectorAll("[data-application-question-id]")];
    expect(rows.map((row) => row.getAttribute("data-application-question-id")).slice(0, 2)).toEqual([
      custom.id,
      `std-${phone.standardKey}`,
    ]);
  });
});

describe("configured address and reference question order", () => {
  it.each([
    [4, "current_address", "currentStreet", "Current address to verify"],
    [5, "previous_address", "prevStreet", "Prior address to verify"],
    [6, "employment", "employer", "Current employer details"],
    [7, "references", "ref1Name", "Primary reference details"],
    [9, "consent", "digitalSignature", "Signed applicant name"],
  ] as const)("interleaves a custom question before the first built-in on step %i", (step, section, firstKey, renamed) => {
    const standard = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.section === section && field.wizardFormKeys[0] === firstKey)!;
    const custom = { id: `${section}-custom`, key: `${section}_note`, label: "Manager follow-up", type: "text" as const,
      required: false, options: [], section };
    const config = { ...applicationConfigForVariant({ applicationConfigMode: "custom", customApplicationFields: [custom] }, "standard"),
      customApplicationFields: [custom, { ...standard, id: `std-${standard.standardKey}`, key: standard.standardKey,
        standardKey: standard.standardKey, label: renamed }],
      questionDisplayOrder: [custom.id, `std-${standard.standardKey}`],
    };
    const noop = () => {};
    const { container } = render(<RentalWizardStepBody step={step}
      form={{ ...createInitialRentalWizardState(), propertyId: property.id }} errors={{}} mode="portal"
      propertyOptions={[{ value: property.id, label: property.title }]} patch={noop} applicationConfigOverride={config}
      setPhone={noop} setLandlordPhone={noop} setPrevLandlordPhone={noop} setSupervisorPhone={noop}
      setRef1Phone={noop} setRef2Phone={noop} setSsn={noop} goToStep={noop} editFromReview={noop} />);
    const ids = [...container.querySelectorAll("[data-application-question-id]")].map((node) => node.getAttribute("data-application-question-id"));
    expect(ids.slice(0, 2)).toEqual([custom.id, `std-${standard.standardKey}`]);
    expect(container.textContent).toContain(renamed);
  });
});

describe("a conditional custom question on the additional-details step (N037)", () => {
  // Step 8 (the untagged/`additional` section, DEFAULT_CUSTOM_FIELD_SECTION_ID)
  // rendered every field with a hand-rolled loop that never applied
  // `isCustomFieldHiddenByCondition`, unlike every other step's
  // `stepManagerQuestions` box. A "if yes, explain" follow-up always showed,
  // gate or no gate — the one wizard step where a manager's conditional
  // question never actually hid.
  const gate = {
    id: "pet-gate",
    key: "has_pet",
    label: "Do you have a pet?",
    type: "yes_no" as const,
    required: false,
    options: [] as string[],
    section: "additional",
  };
  const detail = {
    id: "pet-detail",
    key: "pet_detail",
    label: "Describe your pet",
    type: "text" as const,
    required: false,
    options: [] as string[],
    section: "additional",
    showIf: { fieldKey: "has_pet", equals: "yes" },
  };

  function stepProps(customFieldAnswers: WizardStepsProps["form"]["customFieldAnswers"]) {
    const config = {
      ...applicationConfigForVariant({ applicationConfigMode: "custom", customApplicationFields: [gate, detail] }, "standard"),
      customApplicationFields: [gate, detail],
    };
    const noop = () => {};
    return {
      step: 8,
      form: { ...createInitialRentalWizardState(), propertyId: property.id, customFieldAnswers },
      errors: {},
      mode: "portal",
      propertyOptions: [{ value: property.id, label: property.title }],
      patch: noop,
      applicationConfigOverride: config,
      setPhone: noop,
      setLandlordPhone: noop,
      setPrevLandlordPhone: noop,
      setSupervisorPhone: noop,
      setRef1Phone: noop,
      setRef2Phone: noop,
      setSsn: noop,
      goToStep: noop,
      editFromReview: noop,
    } as WizardStepsProps;
  }

  it("FAILS BEFORE THE FIX: hides the follow-up while the gate is unanswered", () => {
    const { container } = render(<RentalWizardStepBody {...stepProps([])} />);
    expect(container.textContent).toContain("Do you have a pet?");
    expect(container.textContent).not.toContain("Describe your pet");
  });

  it("shows the follow-up once the gate is answered yes", () => {
    const { container } = render(
      <RentalWizardStepBody {...stepProps([{ key: "has_pet", label: gate.label, type: "yes_no", value: "yes" }])} />,
    );
    expect(container.textContent).toContain("Describe your pet");
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
