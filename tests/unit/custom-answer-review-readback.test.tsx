/**
 * @vitest-environment jsdom
 *
 * Manager review must read a custom question's answer back under the section
 * that asked it (not one flat "Manager questions" dump), typed by the
 * question's snapshotted type rather than always as plain text. See
 * `groupCustomFieldAnswersBySection` in `src/lib/rental-application/custom-fields.ts`
 * and its use in `ManagerApplicationReadonlyReview`
 * (`src/components/portal/pro-application-readonly-review.tsx`).
 *
 * The main regression risk: an answer stored before the `section` snapshot
 * existed (or tagged with a section id that no longer exists) must still
 * render, grouped under a trailing "Other questions" heading — never thrown
 * away and never a crash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ManagerApplicationReadonlyReview } from "@/components/portal/pro-application-readonly-review";
import {
  encodeCustomFieldAttachment,
  encodeMultiSelectAnswer,
  groupCustomFieldAnswersBySection,
} from "@/lib/rental-application/custom-fields";
import type { ApplicationPhotoAttachment, RentalCustomFieldAnswer } from "@/lib/rental-application/types";

afterEach(() => cleanup());

// Every non-"custom" review section omitted so only the grouped custom-field
// sections render — matches the pattern in custom-application-file-question.test.tsx.
const OMIT_EVERYTHING_BUT_CUSTOM = [
  "housing",
  "group",
  "cosigner",
  "placement",
  "property",
  "personal",
  "address",
  "employment",
  "references",
  "additional",
  "consent",
] as const;

const attachment: ApplicationPhotoAttachment = {
  storagePath: "application/APP123/custom-1700000000000-abc.pdf.penc",
  fileName: "insurance.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12345,
  uploadedAt: "2026-01-01T00:00:00.000Z",
};

describe("groupCustomFieldAnswersBySection", () => {
  it("returns [] for no answers", () => {
    expect(groupCustomFieldAnswersBySection(undefined)).toEqual([]);
    expect(groupCustomFieldAnswersBySection([])).toEqual([]);
  });

  it("groups answers under their snapshotted sections in RENTAL_APPLICATION_SECTIONS catalogue order, regardless of answer array order", () => {
    // additional (catalogue index 7) is stored BEFORE employment (catalogue
    // index 5) in the answers array — the groups must still come out in
    // catalogue order, not array order.
    const answers: RentalCustomFieldAnswer[] = [
      { key: "pets", label: "Any pets?", type: "text", value: "A cat", section: "additional" },
      { key: "salary", label: "Extra deposit offered", type: "text", value: "$500", section: "employment" },
      { key: "household", label: "Household size", type: "text", value: "3", section: "household" },
    ];
    const groups = groupCustomFieldAnswersBySection(answers);
    expect(groups.map((g) => g.sectionId)).toEqual(["household", "employment", "additional"]);
    expect(groups.map((g) => g.title)).toEqual(["Household application", "Employment & income", "Additional details"]);
    expect(groups.find((g) => g.sectionId === "employment")?.answers.map((a) => a.key)).toEqual(["salary"]);
  });

  it("puts a legacy answer with NO section into a trailing 'Other questions' group instead of dropping it", () => {
    const answers: RentalCustomFieldAnswer[] = [
      { key: "tagged", label: "Tagged question", type: "text", value: "yes tagged", section: "employment" },
      // No `section` at all — this is what every answer stored before this
      // change looks like.
      { key: "legacy", label: "Legacy question", type: "text", value: "an old answer" },
    ];
    const groups = groupCustomFieldAnswersBySection(answers);
    expect(groups.length).toBe(2);
    const other = groups[groups.length - 1];
    expect(other.sectionId).toBeNull();
    expect(other.title).toBe("Other questions");
    expect(other.answers.map((a) => a.key)).toEqual(["legacy"]);
    // Never dropped.
    expect(groups.flatMap((g) => g.answers).map((a) => a.key)).toContain("legacy");
  });

  it("treats an unrecognized section id as sectionless and does not throw", () => {
    const answers: RentalCustomFieldAnswer[] = [
      { key: "orphan", label: "Orphaned question", type: "text", value: "still here", section: "not-a-real-section-id" },
    ];
    expect(() => groupCustomFieldAnswersBySection(answers)).not.toThrow();
    const groups = groupCustomFieldAnswersBySection(answers);
    expect(groups).toEqual([{ sectionId: null, title: "Other questions", answers: answers }]);
  });
});

describe("ManagerApplicationReadonlyReview — typed custom answers", () => {
  it("renders a yes_no answer as a badge reading Yes or No, not raw text", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "hasParking", label: "Has parking?", type: "yes_no", value: "yes", section: "additional" },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("renders a multi_select answer as one chip per selection, never a joined comma string", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            {
              key: "amenities",
              label: "Preferred amenities",
              type: "multi_select",
              value: encodeMultiSelectAnswer(["Gym", "Pool", "Parking"]),
              section: "additional",
            },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    expect(screen.getByText("Gym")).toBeTruthy();
    expect(screen.getByText("Pool")).toBeTruthy();
    expect(screen.getByText("Parking")).toBeTruthy();
    expect(screen.queryByText("Gym, Pool, Parking")).toBeNull();
  });

  it("renders a currency answer as formatted money", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "deposit", label: "Extra deposit offered", type: "currency", value: "1500", section: "employment" },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    expect(screen.getByText("$1,500.00")).toBeTruthy();
  });

  it("still renders the authorized-read thumbnail for a file answer when an applicationId is given", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "proof-of-insurance", label: "Proof of insurance", type: "file", value: encodeCustomFieldAttachment(attachment), section: "additional" },
          ],
        }}
        applicationId="APP123"
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    const img = screen.getByRole("img", { name: attachment.fileName }) as HTMLImageElement;
    expect(img.src).toContain("slot=custom");
    expect(img.src).toContain("key=proof-of-insurance");
    expect(img.src).toContain("applicationId=APP123");
  });

  it("still falls back to a plain file-name chip with no applicationId — never a broken image", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "proof-of-insurance", label: "Proof of insurance", type: "file", value: encodeCustomFieldAttachment(attachment), section: "additional" },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(attachment.fileName)).toBeTruthy();
  });

  it("groups a legacy sectionless answer under a trailing 'Other questions' heading in the rendered review — never vanishes", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "tagged", label: "Tagged question", type: "text", value: "tagged answer", section: "employment" },
            { key: "legacy", label: "Legacy question", type: "text", value: "an old answer" },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Employment & income", "Other questions"]);
    expect(screen.getByText("an old answer")).toBeTruthy();
  });

  it("never leaks JSON into manager-visible copy for any answer type", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            { key: "yn", label: "Yes/no question", type: "yes_no", value: "no", section: "additional" },
            {
              key: "ms",
              label: "Multi-select question",
              type: "multi_select",
              value: encodeMultiSelectAnswer(["Gym", "Pool"]),
              section: "additional",
            },
            { key: "cur", label: "Currency question", type: "currency", value: "2000", section: "additional" },
            { key: "chk", label: "Checkbox question", type: "checkbox", value: "yes", section: "additional" },
            { key: "txt", label: "Text question", type: "text", value: "plain text answer", section: "additional" },
            { key: "file", label: "File question", type: "file", value: encodeCustomFieldAttachment(attachment), section: "additional" },
          ],
        }}
        embedded
        omitSections={[...OMIT_EVERYTHING_BUT_CUSTOM]}
      />,
    );
    const container = screen.getByText("Yes/no question").closest("section");
    expect(container).not.toBeNull();
    const rendered = container!.textContent ?? "";
    expect(rendered.includes("{")).toBe(false);
    expect(rendered.includes("[")).toBe(false);
  });
});
