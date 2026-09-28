// @vitest-environment jsdom
//
// M011 — password strength meter on sign-up / reset. Scoring is local
// (length, case mix, digits, symbols, common-password/keyboard-run penalty)
// — no network call — and the meter is opt-in on PasswordInput via
// `showStrength`, so a plain sign-in or confirm-password field is unaffected.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrengthMeter, scorePasswordStrength } from "@/components/ui/motion/password-strength-meter";

afterEach(() => cleanup());

describe("scorePasswordStrength", () => {
  it("scores an empty password as 0", () => {
    expect(scorePasswordStrength("")).toBe(0);
  });

  it("scores a short password low", () => {
    expect(scorePasswordStrength("abc")).toBe(0);
  });

  it("scores length + case mix + digits + symbols upward", () => {
    expect(scorePasswordStrength("aB3!aB3!aB3!")).toBe(4);
  });

  it("caps a common password at Weak even if it is long", () => {
    expect(scorePasswordStrength("password123")).toBeLessThanOrEqual(1);
  });

  it("penalizes a repeated-character run", () => {
    const withRun = scorePasswordStrength("aaaB3!xyz9$$$");
    const withoutRun = scorePasswordStrength("qzwB3!xyz9$$k");
    expect(withRun).toBeLessThanOrEqual(withoutRun);
  });
});

describe("PasswordStrengthMeter", () => {
  it("shows nothing visible for an empty password (no-subtext while unset)", () => {
    render(<PasswordStrengthMeter password="" />);
    const meter = screen.getByRole("meter", { name: "Password strength" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    const label = document.querySelector(".motion-pw-strength-label");
    expect(label?.classList.contains("is-shown")).toBe(false);
    expect(label?.textContent).toBe("");
  });

  it("shows the strength label once there is a value", () => {
    render(<PasswordStrengthMeter password="aB3!aB3!aB3!" />);
    expect(screen.getByText("Strong")).toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: "Password strength" });
    expect(meter).toHaveAttribute("aria-valuenow", "4");
  });
});

describe("PasswordInput showStrength", () => {
  it("renders no meter by default", () => {
    render(<PasswordInput value="anything" onChange={() => {}} />);
    expect(document.querySelector(".motion-pw-strength")).toBeNull();
  });

  it("renders the meter, wired to the typed value, when showStrength is set", () => {
    render(<PasswordInput value="aB3!aB3!aB3!" onChange={() => {}} showStrength />);
    expect(document.querySelector(".motion-pw-strength")).not.toBeNull();
    expect(screen.getByText("Strong")).toBeInTheDocument();
  });
});
