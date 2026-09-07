// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneNumberField } from "@/components/ui/phone-number-field";

afterEach(() => {
  cleanup();
});

describe("PhoneNumberField", () => {
  it("defaults the country dropdown to +1 and formats the number box", () => {
    const onChange = vi.fn();
    render(<PhoneNumberField id="comm-phone" value="" onChange={onChange} />);

    expect(screen.getByRole("button", { name: "Country code" })).toHaveTextContent("+1");
    fireEvent.change(screen.getByPlaceholderText("(206) 555-0123"), {
      target: { value: "2065550123" },
    });
    expect(onChange).toHaveBeenLastCalledWith("+12065550123");
    expect(screen.getByPlaceholderText("(206) 555-0123")).toHaveValue("(206) 555-0123");
  });

  it("hydrates a numeric stored phone without a trim crash", () => {
    expect(() =>
      render(<PhoneNumberField value={18559168031} onChange={() => undefined} />),
    ).not.toThrow();
    expect(screen.getByRole("textbox")).toHaveValue("(855) 916-8031");
    expect(screen.getByRole("button", { name: "Country code" })).toHaveTextContent("+1");
  });
});
