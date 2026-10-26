// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosignerApplyFlow } from "@/app/(rent)/rent/apply/cosigner-flow";
import { applicationConfigForVariant, STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const submit = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/cosigner-submissions-storage", () => ({ submitCosignerToServerAwait: submit }));

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage?.clear?.();
});

const config = applicationConfigForVariant(createDefaultListingSubmission(), "cosigner");

describe("a linked form opened in the secondary-form flow", () => {
  it("uses the server's questions and never looks the application up through the public link", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    render(
      <CosignerApplyFlow
        onBack={() => undefined}
        linkedForm={{
          requestId: "22222222-2222-4222-8222-222222222222",
          signerAppId: "PROPLANE-APP00001",
          signerFullName: "Ava Lee",
          templateId: "cosigner-form",
          templateVersion: 1,
          config,
        }}
      />,
    );
    expect(screen.getByText("Ava Lee")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("PROPLANE-APP00001")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Signer Application ID")).not.toBeInTheDocument();
    expect(screen.getByText("Personal information")).toBeInTheDocument();
    expect(screen.queryByText(/Checking invite link/i)).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("cosigner-signer-link"))).toHaveLength(0);
  });

  it("uses account identity, skips unconfigured questions, and returns to applications after submission", async () => {
    const done = vi.fn();
    const back = vi.fn();
    const minimalConfig = {
      applicationConfigMode: "custom" as const,
      documentsQuestionsMigrated: true,
      disabledStandardApplicationKeys: STANDARD_APPLICATION_FIELD_CATALOG.filter((field) => !["personal-full-legal-name", "personal-email"].includes(field.standardKey)).map((field) => field.standardKey),
      customApplicationFields: [{ id: "relationship", key: "relationship", label: "Relationship to applicant", type: "text" as const, required: true, options: [], section: "personal" as const }],
    };
    render(<CosignerApplyFlow onBack={back} onDone={done} linkedForm={{
      requestId: "request-1", signerAppId: "PROPLANE-APP00001", signerFullName: "Ava Lee",
      accountName: "Maria Lee", accountEmail: "maria@example.com", config: minimalConfig,
    }} />);
    expect(screen.getByLabelText("Full legal name")).toHaveValue("Maria Lee");
    expect(screen.getByLabelText("Email")).toHaveValue("maria@example.com");
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Relationship to applicant"), { target: { value: "Parent" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Maria Lee")).toBeInTheDocument();
    expect(screen.getByText("maria@example.com")).toBeInTheDocument();
    expect(screen.getByText("Parent")).toBeInTheDocument();
    expect(screen.queryByText("Bankruptcy history")).not.toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByText("Employment")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Phone number")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit co-signer form" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Personal information")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const submitButton = await screen.findByRole("button", { name: "Submit co-signer form" });
    await waitFor(() => expect(submitButton).not.toBeDisabled());
    fireEvent.click(submitButton);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ formRequestId: "request-1", signerAppId: "PROPLANE-APP00001", email: "maria@example.com", consentCredit: false }));
  });

  it("keeps no draft of a helper's answers on the device", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <CosignerApplyFlow
        onBack={() => undefined}
        linkedForm={{ requestId: "22222222-2222-4222-8222-222222222222", signerAppId: "PROPLANE-APP00001", signerFullName: "Ava Lee", config }}
      />,
    );
    expect(setItem.mock.calls.filter(([key]) => /cosigner/i.test(String(key)))).toHaveLength(0);
  });
});
