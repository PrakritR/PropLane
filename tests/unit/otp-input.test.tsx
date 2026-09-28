// @vitest-environment jsdom
//
// M017 — OTP input primitive (built, not yet wired to a live surface: no
// verification-code entry exists anywhere in the product — AGENTS.md, emailed
// auth links are token_hash, never a code). Covered by its own test so the
// primitive is provably correct for whoever wires it in next.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OtpInput } from "@/components/ui/motion/otp-input";

afterEach(() => cleanup());

function Controlled({ length = 6, onComplete }: { length?: number; onComplete?: (code: string) => void }) {
  const [value, setValue] = useState("");
  return <OtpInput length={length} value={value} onChange={setValue} onComplete={onComplete} />;
}

describe("OtpInput", () => {
  it("renders one cell per digit, each with a full accessible label", () => {
    render(<Controlled length={4} />);
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByLabelText(`Verification code, character ${i} of 4`)).toBeInTheDocument();
    }
  });

  it("auto-advances focus as each digit is typed", () => {
    render(<Controlled length={4} />);
    const cell1 = screen.getByLabelText("Verification code, character 1 of 4") as HTMLInputElement;
    const cell2 = screen.getByLabelText("Verification code, character 2 of 4") as HTMLInputElement;
    fireEvent.change(cell1, { target: { value: "5" } });
    expect(document.activeElement).toBe(cell2);
  });

  it("moves focus back on Backspace from an empty cell", () => {
    render(<Controlled length={4} />);
    const cell1 = screen.getByLabelText("Verification code, character 1 of 4") as HTMLInputElement;
    const cell2 = screen.getByLabelText("Verification code, character 2 of 4") as HTMLInputElement;
    cell2.focus();
    fireEvent.keyDown(cell2, { key: "Backspace" });
    expect(document.activeElement).toBe(cell1);
  });

  it("moves focus with Arrow Left / Right", () => {
    render(<Controlled length={3} />);
    const cell1 = screen.getByLabelText("Verification code, character 1 of 3") as HTMLInputElement;
    const cell2 = screen.getByLabelText("Verification code, character 2 of 3") as HTMLInputElement;
    cell1.focus();
    fireEvent.keyDown(cell1, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell2);
    fireEvent.keyDown(cell2, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell1);
  });

  it("splits a full paste across cells and focuses the last filled one", () => {
    render(<Controlled length={4} />);
    const cell1 = screen.getByLabelText("Verification code, character 1 of 4") as HTMLInputElement;
    fireEvent.paste(cell1, { clipboardData: { getData: () => "1234" } });
    expect((screen.getByLabelText("Verification code, character 4 of 4") as HTMLInputElement)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText("Verification code, character 4 of 4"));
  });

  it("calls onComplete exactly once the code reaches full length", () => {
    const onComplete = vi.fn();
    render(<Controlled length={2} onComplete={onComplete} />);
    const cell1 = screen.getByLabelText("Verification code, character 1 of 2") as HTMLInputElement;
    fireEvent.paste(cell1, { clipboardData: { getData: () => "12" } });
    expect(onComplete).toHaveBeenCalledWith("12");
  });

  it("shows an accessible incorrect-code status when the caller marks it an error", () => {
    render(<OtpInput length={4} value="1234" onChange={() => {}} error />);
    expect(screen.getByText("Incorrect code")).toBeInTheDocument();
  });
});
