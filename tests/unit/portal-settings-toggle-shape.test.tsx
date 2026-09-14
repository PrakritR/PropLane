/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";

/**
 * The portal HIG layer in globals.css forces every button inside `.portal-shell`
 * to `min-height: 2.75rem` at every width. A switch that carries its own height
 * on the <button> loses that fight and renders as a 36x44 blob instead of a
 * 36x21 pill. The pill must therefore live on a child element.
 */
describe("PortalSettingsToggle", () => {
  it("keeps the pill off the button so the 44px touch-target rule cannot distort it", () => {
    render(<PortalSettingsToggle checked label="Late fee notices" onChange={() => {}} />);
    const button = screen.getByRole("switch", { name: "Late fee notices" });
    expect(button.className).not.toMatch(/h-\[21px\]/);
    const pill = button.querySelector("span");
    expect(pill).not.toBeNull();
    expect(pill!.className).toMatch(/h-\[21px\]/);
    expect(pill!.className).toMatch(/w-\[36px\]/);
  });

  it("moves the knob across the track rather than resizing it", () => {
    const { rerender } = render(<PortalSettingsToggle checked={false} label="Knob" onChange={() => {}} />);
    const off = screen.getByRole("switch", { name: "Knob" }).querySelector("span > span")!;
    expect(off.className).toMatch(/left-\[2\.5px\]/);
    rerender(<PortalSettingsToggle checked label="Knob" onChange={() => {}} />);
    const on = screen.getByRole("switch", { name: "Knob" }).querySelector("span > span")!;
    expect(on.className).toMatch(/left-\[17\.5px\]/);
  });
});
