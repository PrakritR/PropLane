// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosignerApplyFlow } from "@/app/(public)/rent/apply/cosigner-flow";
import { applicationConfigForVariant } from "@/lib/rental-application/application-field-catalog";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

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
    expect(screen.getByDisplayValue("PROPLANE-APP00001")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ava Lee")).toBeInTheDocument();
    expect(screen.queryByText(/Checking invite link/i)).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("cosigner-signer-link"))).toHaveLength(0);
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
