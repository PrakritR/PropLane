// @vitest-environment jsdom
//
// M010 — inline validation reserved-space error slot
// (listing-wizard-v2/wizard-primitives.tsx's Field). A field that never
// passes `error` keeps today's exact layout (no slot); a field that DOES
// track validation (passes `error`, even `undefined`) reserves a fixed-
// height slot up front, so the message crossfading in later never shoves
// the control below it. No-subtext rule: the slot renders no visible text
// while the field is valid.
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { Field } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(() => cleanup());

describe("Field's M010 reserved-space error slot", () => {
  it("reserves no slot at all for a field that never tracks validation", () => {
    render(
      <Field label="Name">
        <input aria-label="Name" />
      </Field>,
    );
    expect(document.querySelector(".motion-field-error-slot")).toBeNull();
  });

  it("reserves the slot, invisibly, the moment a field is validate-able — even with no error yet", () => {
    render(
      <Field label="Email" error={undefined}>
        <input aria-label="Email" />
      </Field>,
    );
    const slot = document.querySelector(".motion-field-error-slot");
    expect(slot).not.toBeNull();
    // No-subtext: nothing visible while valid.
    const msg = slot!.querySelector(".motion-field-error");
    expect(msg?.classList.contains("is-shown")).toBe(false);
    expect(msg?.textContent).toBe("");
  });

  it("shows the message, crossfaded in, inside the already-reserved slot once invalid", () => {
    const { rerender } = render(
      <Field label="Email" error={undefined}>
        <input aria-label="Email" />
      </Field>,
    );
    expect(document.querySelector(".motion-field-error-slot")).not.toBeNull();

    rerender(
      <Field label="Email" error="Enter a valid email address.">
        <input aria-label="Email" />
      </Field>,
    );
    // Same slot, not a newly-inserted one — the DOM node never moved.
    const slot = document.querySelector(".motion-field-error-slot");
    const msg = screen.getByText("Enter a valid email address.");
    expect(slot).not.toBeNull();
    expect(msg.classList.contains("is-shown")).toBe(true);
    expect(msg.getAttribute("role")).toBe("status");
    expect(msg.getAttribute("aria-live")).toBe("polite");
  });

  it("reserves the slot for a group field the same way", () => {
    render(
      <Field label="Amenities" group error="Pick at least one.">
        <div>chips</div>
      </Field>,
    );
    expect(document.querySelector(".motion-field-error-slot")).not.toBeNull();
    expect(screen.getByText("Pick at least one.")).toBeInTheDocument();
  });
});
