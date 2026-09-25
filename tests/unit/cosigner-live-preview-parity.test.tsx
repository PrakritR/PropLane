// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CosignerApplyFlow } from "@/app/(public)/rent/apply/cosigner-flow";
import { applicationConfigForVariant } from "@/lib/rental-application/application-field-catalog";
import { encodeMultiSelectAnswer, parseMultiSelectAnswer } from "@/lib/rental-application/custom-fields";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("uses the live co-signer form for manager preview without fetching or submitting", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const config = applicationConfigForVariant(null, "cosigner");
  const view = render(<CosignerApplyFlow onBack={() => {}} previewMode previewConfig={config} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Personal information")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();

  view.rerender(<CosignerApplyFlow onBack={() => {}} previewMode previewConfig={{ ...config, disabledStandardApplicationKeys: [...config.disabledStandardApplicationKeys, "personal-date-of-birth"] }} />);
  expect(screen.queryByLabelText("Date of birth")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("encodes co-signer multi-select choices and blocks unavailable file questions", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const base = applicationConfigForVariant(null, "cosigner");
  const config = {
    ...base,
    applicationConfigMode: "custom" as const,
    customApplicationFields: [
      { id: "caf-long", key: "income-explanation", label: "Income explanation", type: "long_text" as const, required: true, options: [], section: "household" },
      { id: "caf-choice", key: "preferred-features", label: "Preferred features", type: "multi_select" as const, required: true, options: ["Laundry", "Parking"], section: "household" },
      { id: "caf-file", key: "supporting-document", label: "Supporting document", type: "file" as const, required: true, options: [], section: "household" },
    ],
  };
  render(<CosignerApplyFlow onBack={() => {}} previewMode previewConfig={config} />);

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Preferred features")).toBeTruthy();
  const incomeExplanation = document.querySelector('[data-wizard-field="custom:income-explanation"] textarea') as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Income explanation is required.")).toBeTruthy();
  fireEvent.change(incomeExplanation, { target: { value: "I have stable monthly income." } });
  const laundry = screen.getByRole("checkbox", { name: "Laundry" }) as HTMLInputElement;
  const parking = screen.getByRole("checkbox", { name: "Parking" }) as HTMLInputElement;
  fireEvent.click(laundry);
  fireEvent.click(parking);
  expect(laundry.checked).toBe(true);
  expect(parking.checked).toBe(true);
  expect(encodeMultiSelectAnswer(["Laundry", "Parking"])).toBe('["Laundry","Parking"]');
  expect(parseMultiSelectAnswer('["Laundry","Parking"]')).toEqual(["Laundry", "Parking"]);
  expect(screen.queryByText("Income explanation is required.")).toBeNull();
  expect(screen.getAllByText("File upload questions are not available on co-signer forms yet. Contact the property manager.").length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getAllByText("File upload questions are not available on co-signer forms yet. Contact the property manager.").length).toBeGreaterThan(1));
});

it("loads the same custom question controls from the live signer link", async () => {
  const config = {
    ...applicationConfigForVariant(null, "cosigner"),
    applicationConfigMode: "custom" as const,
    customApplicationFields: [
      { id: "caf-live", key: "preferred-features", label: "Preferred features", type: "multi_select" as const, required: false, options: ["Laundry", "Parking"], section: "household" },
    ],
  };
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({ ok: true, signerAppId: "AXIS-1234", signerFullName: "Primary Applicant", applicationConfig: config }),
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<CosignerApplyFlow onBack={() => {}} initialSignerAppId="AXIS-1234" />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("checkbox", { name: "Laundry" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Parking" })).toBeTruthy();
});
