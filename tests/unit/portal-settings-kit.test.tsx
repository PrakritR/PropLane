// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PortalSettingsDisclosureRow,
  PortalSettingsLockedRow,
  PortalSettingsRow,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";

afterEach(() => cleanup());

describe("PortalSettingsToggle", () => {
  it("renders role=switch and reflects aria-checked", () => {
    const { rerender } = render(
      <PortalSettingsToggle checked={false} onChange={() => {}} label="Late fee notices" />,
    );
    const toggle = screen.getByRole("switch", { name: "Late fee notices" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    rerender(<PortalSettingsToggle checked onChange={() => {}} label="Late fee notices" />);
    expect(screen.getByRole("switch", { name: "Late fee notices" })).toHaveAttribute("aria-checked", "true");
  });

  it("fires onChange with the flipped value", () => {
    const onChange = vi.fn();
    render(<PortalSettingsToggle checked={false} onChange={onChange} label="Reminders" />);
    fireEvent.click(screen.getByRole("switch", { name: "Reminders" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire onChange when disabled", () => {
    const onChange = vi.fn();
    render(<PortalSettingsToggle checked={false} onChange={onChange} label="Reminders" disabled />);
    const toggle = screen.getByRole("switch", { name: "Reminders" });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PortalSettingsLockedRow", () => {
  it("always carries its reason — for assistive tech and on hover, never as a visible sentence", () => {
    render(<PortalSettingsLockedRow label="Custom domain" reason="Upgrade to Pro to set a custom domain." />);
    const reason = screen.getByText("Upgrade to Pro to set a custom domain.");
    expect(reason).toBeInTheDocument();
    expect(reason.className).toContain("sr-only");
    expect(screen.getByText("Custom domain").closest("p")?.getAttribute("title")).toBe(
      "Upgrade to Pro to set a custom domain.",
    );
  });
});

describe("PortalSettingsRow", () => {
  it("renders the label and nothing under it", () => {
    const { container } = render(<PortalSettingsRow label="API key">control</PortalSettingsRow>);
    expect(screen.getByText("API key")).toBeInTheDocument();
    // One <p> — the label. A second line is the subtext the kit exists to forbid.
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("PortalSettingsDisclosureRow", () => {
  it("starts collapsed, toggles aria-expanded, and hides/shows content", () => {
    render(
      <PortalSettingsDisclosureRow label="Advanced" description="More detail">
        <p>Secret detail</p>
      </PortalSettingsDisclosureRow>,
    );

    const trigger = screen.getByRole("button", { name: /Advanced/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Content is genuinely absent/hidden while collapsed.
    const content = screen.getByText("Secret detail");
    expect(content.closest("[hidden]")).not.toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Secret detail").closest("[hidden]")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Secret detail").closest("[hidden]")).not.toBeNull();
  });
});

describe("hand-rolled checkbox class string removed from assigned files", () => {
  const BANNED = "mt-0.5 h-4 w-4 shrink-0 accent-primary";
  const ASSIGNED_FILES = [
    "src/components/portal/task-automation-settings-fields.tsx",
    "src/components/portal/promotion-asset-list.tsx",
    "src/components/portal/service-request-catalog-editor.tsx",
    "src/components/portal/pro-property-lease-panel.tsx",
    "src/components/portal/pro-property-application-questions-panel.tsx",
    "src/components/portal/pro-resident-tours-panel.tsx",
    "src/components/portal/payment-schedule-ui.tsx",
  ];

  it.each(ASSIGNED_FILES)("%s no longer contains the duplicated raw checkbox class string", (relPath) => {
    const contents = readFileSync(join(process.cwd(), relPath), "utf8");
    expect(contents).not.toContain(BANNED);
  });
});
