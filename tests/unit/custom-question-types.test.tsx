/**
 * @vitest-environment jsdom
 *
 * The six new manager-defined application question types (`long_text`,
 * `currency`, `yes_no`, `multi_select`, `phone`, `email`) each render the
 * right applicant control (never a bare text box for `yes_no`, never raw JSON
 * on display for `multi_select`), and `photos` — retired from the manager
 * picker but still a valid stored type — must keep normalizing to `photos`,
 * never silently downgrade to `text`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import {
  encodeMultiSelectAnswer,
  formatCustomFieldAnswerDisplay,
  parseMultiSelectAnswer,
} from "@/lib/rental-application/custom-fields";
import {
  CUSTOM_APPLICATION_FIELD_TYPES,
  CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS,
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
  type ManagerCustomApplicationFieldType,
} from "@/lib/manager-listing-submission";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";

afterEach(() => cleanup());

function baseField(overrides: Partial<ManagerCustomApplicationField>): ManagerCustomApplicationField {
  return {
    id: "f1",
    key: "q1",
    label: "Question label",
    type: "text",
    required: false,
    options: [],
    ...overrides,
  };
}

describe("photos is retired from the picker but stays a valid stored type", () => {
  it("CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS (the picker) no longer offers photos", () => {
    expect(CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.some((o) => o.id === "photos")).toBe(false);
  });

  it("CUSTOM_APPLICATION_FIELD_TYPES (valid stored data) still includes photos", () => {
    expect(CUSTOM_APPLICATION_FIELD_TYPES).toContain("photos");
  });

  it("a stored photos question normalizes to photos, NOT downgraded to text", () => {
    const normalized = normalizeCustomApplicationFields([
      { id: "caf-1", key: "id-photo", label: "Photo of your ID", type: "photos", required: true },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].type).toBe("photos");
  });

  it("every new type is a valid stored type", () => {
    const newTypes: ManagerCustomApplicationFieldType[] = [
      "long_text",
      "currency",
      "yes_no",
      "multi_select",
      "phone",
      "email",
    ];
    for (const type of newTypes) {
      expect(CUSTOM_APPLICATION_FIELD_TYPES).toContain(type);
      expect(CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.some((o) => o.id === type)).toBe(true);
    }
  });

  it("an unrecognized type still normalizes to text", () => {
    const normalized = normalizeCustomApplicationFields([
      { id: "caf-2", key: "mystery", label: "Mystery field", type: "not-a-real-type" },
    ]);
    expect(normalized[0].type).toBe("text");
  });
});

describe("CustomQuestionField renders the right control for each new type", () => {
  it("long_text renders a textarea, not a text input", () => {
    render(
      <CustomQuestionField field={baseField({ type: "long_text" })} value="" onChange={() => {}} />,
    );
    const el = screen.getByLabelText("Question label", { exact: false });
    expect(el.tagName).toBe("TEXTAREA");
  });

  it("currency renders a decimal text input with a $ affix", () => {
    render(<CustomQuestionField field={baseField({ type: "currency" })} value="" onChange={() => {}} />);
    const el = screen.getByLabelText("Question label", { exact: false }) as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el.getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByText("$")).toBeTruthy();
  });

  it("yes_no renders two choice controls, never a bare input", () => {
    render(<CustomQuestionField field={baseField({ type: "yes_no" })} value="" onChange={() => {}} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
  });

  it("multi_select renders a checkbox per option", () => {
    render(
      <CustomQuestionField
        field={baseField({ type: "multi_select", options: ["Cats", "Dogs", "Fish"] })}
        value=""
        onChange={() => {}}
      />,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("Cats")).toBeTruthy();
  });

  it("phone renders a tel-mode input", () => {
    render(<CustomQuestionField field={baseField({ type: "phone" })} value="" onChange={() => {}} />);
    const el = screen.getByLabelText("Question label", { exact: false });
    expect(el.getAttribute("inputmode")).toBe("tel");
  });

  it("email renders a type=email input", () => {
    render(<CustomQuestionField field={baseField({ type: "email" })} value="" onChange={() => {}} />);
    const el = screen.getByLabelText("Question label", { exact: false }) as HTMLInputElement;
    expect(el.type).toBe("email");
    expect(el.getAttribute("inputmode")).toBe("email");
  });

  it("a photos question's uploader accepts images only (a file question keeps images+PDF)", () => {
    const { container: photosContainer } = render(
      <CustomQuestionField
        field={baseField({ type: "photos" })}
        value=""
        onChange={() => {}}
        getApplicationId={() => "APP1"}
      />,
    );
    const photosAccept = photosContainer.querySelectorAll('input[type="file"]')[1]?.getAttribute("accept") ?? "";
    expect(photosAccept).not.toContain("pdf");
    expect(photosAccept).toContain("image/");
    cleanup();

    const { container: fileContainer } = render(
      <CustomQuestionField
        field={baseField({ type: "file" })}
        value=""
        onChange={() => {}}
        getApplicationId={() => "APP1"}
      />,
    );
    const fileAccept = fileContainer.querySelector('input[type="file"]')?.getAttribute("accept") ?? "";
    expect(fileAccept).toContain("pdf");
  });

  it("renders a description as muted help text under the label, for every type", () => {
    render(
      <CustomQuestionField
        field={baseField({ type: "text", description: "This helps us process your application faster." })}
        value=""
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("This helps us process your application faster.")).toBeTruthy();
  });
});

describe("multi_select answer encoding", () => {
  it("round-trips through encode -> parse", () => {
    const encoded = encodeMultiSelectAnswer(["Cats", "Dogs"]);
    expect(typeof encoded).toBe("string");
    expect(parseMultiSelectAnswer(encoded)).toEqual(["Cats", "Dogs"]);
  });

  it("an empty selection round-trips to []", () => {
    expect(parseMultiSelectAnswer(encodeMultiSelectAnswer([]))).toEqual([]);
  });
});

describe("parseMultiSelectAnswer tolerates non-JSON-array input", () => {
  it("blank string -> []", () => {
    expect(parseMultiSelectAnswer("")).toEqual([]);
  });

  it("malformed JSON -> a single-item legacy selection, never throws", () => {
    expect(() => parseMultiSelectAnswer("[not valid json")).not.toThrow();
    expect(parseMultiSelectAnswer("[not valid json")).toEqual(["[not valid json"]);
  });

  it("a legacy plain-string answer (pre-multi_select) -> a single-item selection", () => {
    expect(parseMultiSelectAnswer("Studio apartment")).toEqual(["Studio apartment"]);
  });

  it("valid JSON that isn't an array -> []", () => {
    expect(parseMultiSelectAnswer("42")).toEqual([]);
    expect(parseMultiSelectAnswer('{"a":1}')).toEqual([]);
  });
});

describe("formatCustomFieldAnswerDisplay never leaks JSON for a new type", () => {
  function answerFor(type: ManagerCustomApplicationFieldType, value: string): RentalCustomFieldAnswer {
    return { key: "k", label: "L", type, value };
  }

  it("yes_no -> Yes / No", () => {
    expect(formatCustomFieldAnswerDisplay(answerFor("yes_no", "yes"))).toBe("Yes");
    expect(formatCustomFieldAnswerDisplay(answerFor("yes_no", "no"))).toBe("No");
  });

  it("multi_select -> comma-joined selections, never raw JSON", () => {
    const value = encodeMultiSelectAnswer(["Cats", "Dogs"]);
    const display = formatCustomFieldAnswerDisplay(answerFor("multi_select", value));
    expect(display).toBe("Cats, Dogs");
    expect(display.includes("[")).toBe(false);
    expect(display.includes("{")).toBe(false);
  });

  it("currency -> formatted money", () => {
    expect(formatCustomFieldAnswerDisplay(answerFor("currency", "1200.5"))).toBe("$1,200.50");
    expect(formatCustomFieldAnswerDisplay(answerFor("currency", "$1,200"))).toBe("$1,200.00");
  });

  it("no new type's display ever contains [ or {", () => {
    const cases: [ManagerCustomApplicationFieldType, string][] = [
      ["long_text", "Some free text, with (parens) and other punctuation."],
      ["currency", "500"],
      ["yes_no", "yes"],
      ["multi_select", encodeMultiSelectAnswer(["A", "B"])],
      ["phone", "(206) 555-0123"],
      ["email", "person@example.com"],
    ];
    for (const [type, value] of cases) {
      const display = formatCustomFieldAnswerDisplay(answerFor(type, value));
      expect(display.includes("[")).toBe(false);
      expect(display.includes("{")).toBe(false);
    }
  });
});
