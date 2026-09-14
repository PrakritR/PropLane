/**
 * @vitest-environment jsdom
 *
 * Manager-defined application questions of type `photos`/`file` must render a
 * real upload control to the applicant (never a plain text box), round-trip
 * through the string-typed `RentalCustomFieldAnswer.value` as JSON attachment
 * metadata (never bytes, never raw JSON on display), and give the manager a
 * thumbnail on review — see the "custom" `ApplicationPhotoSlot` contract in
 * `src/lib/rental-application/types.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import { ManagerApplicationReadonlyReview } from "@/components/portal/pro-application-readonly-review";
import {
  encodeCustomFieldAttachment,
  formatCustomFieldAnswerDisplay,
  parseCustomFieldAttachment,
} from "@/lib/rental-application/custom-fields";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { ApplicationPhotoAttachment, RentalCustomFieldAnswer } from "@/lib/rental-application/types";

afterEach(() => cleanup());

const fileField: ManagerCustomApplicationField = {
  id: "f1",
  key: "proof-of-insurance",
  label: "Proof of insurance",
  type: "file",
  required: true,
  options: [],
};

const attachment: ApplicationPhotoAttachment = {
  storagePath: "application/APP123/custom-1700000000000-abc.pdf.penc",
  fileName: "insurance.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12345,
  uploadedAt: "2026-01-01T00:00:00.000Z",
};

describe("CustomQuestionField — file/photos question type", () => {
  it("renders an upload control, not a text input", () => {
    render(
      <CustomQuestionField
        field={fileField}
        value=""
        onChange={() => {}}
        getApplicationId={() => "APP123"}
      />,
    );

    // No text input anywhere for this field.
    expect(screen.queryByRole("textbox")).toBeNull();
    // Upload affordance is present (file-only field hides camera capture).
    expect(screen.getByRole("button", { name: /upload file/i })).toBeTruthy();
  });

  it("renders the camera option too for a photos-type question", () => {
    render(
      <CustomQuestionField
        field={{ ...fileField, type: "photos" }}
        value=""
        onChange={() => {}}
        getApplicationId={() => "APP123"}
      />,
    );
    expect(screen.getByRole("button", { name: /take photo/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /upload file/i })).toBeTruthy();
  });
});

describe("custom-field file attachment round trip", () => {
  it("encodeCustomFieldAttachment -> parseCustomFieldAttachment returns the same attachment", () => {
    const encoded = encodeCustomFieldAttachment(attachment);
    expect(typeof encoded).toBe("string");
    expect(parseCustomFieldAttachment(encoded)).toEqual(attachment);
  });

  it("an empty answer round-trips to null", () => {
    expect(encodeCustomFieldAttachment(null)).toBe("");
    expect(parseCustomFieldAttachment("")).toBeNull();
  });

  it("formatCustomFieldAnswerDisplay returns the file name and never raw JSON", () => {
    const answer: RentalCustomFieldAnswer = {
      key: fileField.key,
      label: fileField.label,
      type: "file",
      value: encodeCustomFieldAttachment(attachment),
    };
    const display = formatCustomFieldAnswerDisplay(answer);
    expect(display).toBe("insurance.pdf");
    expect(display.includes("{")).toBe(false);
  });

  it("formatCustomFieldAnswerDisplay is blank for an unanswered or unparseable file question", () => {
    expect(
      formatCustomFieldAnswerDisplay({ key: "k", label: "L", type: "file", value: "" }),
    ).toBe("");
    expect(
      formatCustomFieldAnswerDisplay({ key: "k", label: "L", type: "file", value: "not json" }),
    ).toBe("");
  });
});

describe("ManagerApplicationReadonlyReview — manager questions thumbnail", () => {
  it("renders an <img> whose src carries slot=custom and the question's key when given an applicationId", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            {
              key: fileField.key,
              label: fileField.label,
              type: "file",
              value: encodeCustomFieldAttachment(attachment),
            },
          ],
        }}
        applicationId="APP123"
        embedded
        omitSections={["housing", "group", "cosigner", "property", "personal", "address", "employment", "references", "additional", "consent"]}
      />,
    );

    const img = screen.getByRole("img", { name: attachment.fileName }) as HTMLImageElement;
    expect(img.src).toContain("slot=custom");
    expect(img.src).toContain(`key=${fileField.key}`);
    expect(img.src).toContain("applicationId=APP123");
  });

  it("falls back to a plain file-name chip with no applicationId — never a broken image", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{
          customFieldAnswers: [
            {
              key: fileField.key,
              label: fileField.label,
              type: "file",
              value: encodeCustomFieldAttachment(attachment),
            },
          ],
        }}
        embedded
        omitSections={["housing", "group", "cosigner", "property", "personal", "address", "employment", "references", "additional", "consent"]}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(attachment.fileName)).toBeTruthy();
  });
});
