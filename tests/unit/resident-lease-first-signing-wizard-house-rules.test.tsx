// @vitest-environment jsdom
/**
 * C276 — a lease template's "House rules addendum" section carries its own
 * real, individually-classified clauses (C282's `looksLikeSectionHeader`
 * groups an imported PDF's own headings, mirrored here by a synthetic
 * fixture with the same shape): numbered read-only rule clauses, a single
 * final acknowledgment step requiring BOTH initials and a date, and a
 * `flagged` clause rendered in red with a non-color cue (the PDF's own
 * detected fill color, see `HOUSE_RULES_SECTION_RE`'s comment).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResidentLeaseFirstSigningWizard } from "@/components/portal/resident-lease-first-signing-wizard";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const updateLeasePipelineRow = vi.fn();
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, updateLeasePipelineRow: (...args: unknown[]) => updateLeasePipelineRow(...args) };
});

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function row(): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Jordan Reyes",
    residentEmail: "jreyes@test.com",
    unit: "Room 2",
    status: "Resident Signature Pending",
    bucket: "resident",
    leaseFirst: true,
    generatedHtml: "<p>Lease body</p>",
    signingTemplateSnapshot: {
      version: 1,
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: "hr-1",
          key: "house_rule_1",
          label: "No smoking anywhere on the property.",
          type: "long_text",
          required: false,
          options: [],
          description: "No smoking anywhere on the property, including balconies and the shared yard.",
          section: "VIII. House rules addendum",
        },
        {
          id: "hr-2",
          key: "house_rule_2",
          label: "Quiet hours are 10pm to 7am.",
          type: "long_text",
          required: false,
          options: [],
          description: "Quiet hours are 10pm to 7am on weeknights and 11pm to 8am on weekends.",
          section: "VIII. House rules addendum",
        },
        {
          id: "hr-ack",
          key: "la_house_rules_ack",
          label: "I have read and understand the house rules.",
          type: "initials",
          required: true,
          options: [],
          section: "VIII. House rules addendum",
        },
      ],
    },
  } as unknown as LeasePipelineRow;
}

describe("ResidentLeaseFirstSigningWizard — house rules addendum", () => {
  it("renders each rule as a numbered read-only clause, not an editable question", () => {
    render(<ResidentLeaseFirstSigningWizard row={row()} onReachedSign={vi.fn()} />);

    expect(screen.getByText(/No smoking anywhere on the property/)).toBeTruthy();
    expect(screen.getByText(/Quiet hours are 10pm to 7am/)).toBeTruthy();
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    // A rule clause is read-only text, never a textarea/input a resident could edit.
    expect(screen.queryByRole("textbox", { name: /smoking/i })).toBeNull();
  });

  it("renders a flagged (red-detected) clause in the danger token with an accessible non-color cue", () => {
    const flaggedRow = row();
    flaggedRow.signingTemplateSnapshot!.customApplicationFields[0] = {
      ...flaggedRow.signingTemplateSnapshot!.customApplicationFields[0]!,
      flagged: true,
    };
    render(<ResidentLeaseFirstSigningWizard row={flaggedRow} onReachedSign={vi.fn()} />);

    const flaggedText = screen.getByText(/No smoking anywhere on the property/);
    expect(flaggedText.className).toContain("text-danger");
    expect(screen.getByRole("img", { name: "Important" })).toBeTruthy();

    // The other (unflagged) rule keeps its ordinary styling and no cue.
    const ordinaryText = screen.getByText(/Quiet hours are 10pm to 7am/);
    expect(ordinaryText.className).not.toContain("text-danger");
    expect(screen.getAllByRole("img", { name: "Important" })).toHaveLength(1);
  });

  it("requires both initials and a date before Continue is enabled, and saves both", () => {
    render(<ResidentLeaseFirstSigningWizard row={row()} onReachedSign={vi.fn()} />);

    const continueButton = screen.getByText("Continue") as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Initials/), { target: { value: "jr" } });
    expect(continueButton.disabled).toBe(true); // date still missing

    fireEvent.change(screen.getByLabelText(/Date/), { target: { value: "2026-09-26" } });
    expect(continueButton.disabled).toBe(false);

    fireEvent.click(continueButton);
    expect(updateLeasePipelineRow).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({
        signingAnswers: expect.objectContaining({ la_house_rules_ack: "JR", la_house_rules_ack__date: "2026-09-26" }),
      }),
    );
  });

  it("does not gate Continue on a date for an ordinary (non-house-rules) clause step", () => {
    const singleRule = row();
    singleRule.signingTemplateSnapshot!.customApplicationFields = [
      {
        id: "fee-ack",
        key: "fee_ack",
        label: "I accept the fee schedule.",
        type: "initials",
        required: true,
        options: [],
        section: "I. Fees",
      },
    ];
    render(<ResidentLeaseFirstSigningWizard row={singleRule} onReachedSign={vi.fn()} />);

    const continueButton = screen.getByText("Continue") as HTMLButtonElement;
    // Initials default-fill from the resident's own name, so an ordinary clause step
    // (unlike house rules) is never gated on anything beyond that existing behavior.
    expect(continueButton.disabled).toBe(false);
    // Today's ordinary clause step never renders a date field.
    expect(screen.queryByLabelText(/Date/)).toBeNull();
  });
});
