// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResidentLifecyclePhone } from "@/components/marketing/resident-lifecycle-phone";

const props = { caption: "Resident's phone", contact: { initials: "PL", name: "PropLane", sub: "Messages" }, items: [] };
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("read-only story phone", () => {
  it("shows an inert composer without back, video, attachment, or send controls", () => {
    const { container } = render(<ResidentLifecyclePhone {...props} readOnly hideCaption />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector(".rl-phone-caption")).toBeNull();
    expect(screen.getByText("Text message")).toBeVisible();
  });

  it("preserves the existing sample-reply interaction by default", () => {
    render(<ResidentLifecyclePhone {...props} />);
    expect(screen.getByText("Resident's phone")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to conversations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Video call" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Write a reply" }), { target: { value: "Thank you" } });
    fireEvent.click(screen.getByRole("button", { name: "Send sample reply" }));
    expect(screen.getByText("Thank you")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Write a reply" })).toHaveValue("");
  });
});
