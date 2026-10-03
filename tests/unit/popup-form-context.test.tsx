// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { PopupFormContext, PopupFormSnapshot, readPopupFields } from "@/components/ui/popup-form-context";
import { PopupMessagePreview } from "@/components/portal/popup-live-preview";

describe("popup form context", () => {
  it("excludes hidden controls and passwords from the read-only context", () => {
    const root = document.createElement("div");
    root.innerHTML = '<label>Name<input value="Ada"></label><label>Password<input type="password" value="secret"></label><input type="hidden" aria-label="token" value="secret"><div hidden><input aria-label="old field" value="old"></div>';
    expect(readPopupFields(root).map(({ label, value }) => ({ label, value }))).toEqual([{ label: "Name", value: "Ada" }]);
  });
  it("updates completion from native validity and focuses the missing field", async () => {
    function Form() {
      const ref = useRef<HTMLDivElement>(null);
      return <><div ref={ref}><label htmlFor="context-email">Email</label><input id="context-email" type="email" required /></div><PopupFormContext formRef={ref} hasContext /></>;
    }
    render(<Form />);
    fireEvent.click(await screen.findByRole("button", { name: "Email" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "ada@example.test" } });
    await waitFor(() => expect(screen.queryByText("1 thing to finish")).toBeNull());
  });
  it("uses selected option text without mixing the options into the field label", () => {
    const root = document.createElement("div");
    root.innerHTML = '<label>Method<select><option>Standard</option><option selected>Instant</option></select></label>';
    expect(readPopupFields(root).map(({ label, value }) => ({ label, value }))).toEqual([{ label: "Method", value: "Instant" }]);
  });
  it("keeps the generic snapshot live as field values change", async () => {
    function Form() {
      const ref = useRef<HTMLDivElement>(null);
      return <><div ref={ref}><label>Display name<input defaultValue="Before" /></label></div><PopupFormSnapshot formRef={ref} /></>;
    }
    render(<Form />);
    expect(await screen.findByText("Before")).toBeTruthy();
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "After" } });
    expect(await screen.findByText("After")).toBeTruthy();
    expect(screen.queryByText("Before")).toBeNull();
  });
  it("renders the controlled draft as text and updates without interpreting HTML", () => {
    const { rerender } = render(<PopupMessagePreview subject="Before" body="<script>test</script>" recipient="Ada" />);
    expect(screen.getByText("<script>test</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    rerender(<PopupMessagePreview subject="After" body="Updated message" recipient="Ben" />);
    expect(screen.getByText("Updated message")).toBeTruthy();
    expect(screen.queryByText("Before")).toBeNull();
  });
});
