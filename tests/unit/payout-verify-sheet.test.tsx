// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div role="dialog">
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ component }: { component: string }) => <div data-testid="embedded">{component}</div>,
}));

const { createTokenMock } = vi.hoisted(() => ({ createTokenMock: vi.fn() }));
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: () => Promise.resolve({ createToken: createTokenMock }),
}));

import { PayoutVerifySheet } from "@/components/portal/payout-verify-sheet";

const OWN_FORM_REQUIREMENTS = {
  status: "needs_info",
  isApplicationCollected: true,
  fallbackToEmbedded: false,
  currentlyDue: ["individual.first_name", "individual.last_name", "individual.ssn_last_4"],
  disabledReason: null,
  fields: [
    { key: "individual.legal_name", type: "text", label: "Legal name", requirementKeys: ["individual.first_name", "individual.last_name"] },
    { key: "individual.ssn_last_4", type: "text", label: "Last 4 of SSN", sensitive: true, requirementKeys: ["individual.ssn_last_4"] },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  createTokenMock.mockReset();
  createTokenMock.mockResolvedValue({ token: { id: "acct_tok_123" }, error: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PayoutVerifySheet", () => {
  it("renders the spec's own fields (label + control) for an application-collected account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(OWN_FORM_REQUIREMENTS)));
    render(
      <PayoutVerifySheet open onClose={vi.fn()} connectBase="/api/stripe/connect" />,
    );
    expect(await screen.findByText("Legal name")).toBeInTheDocument();
    expect(screen.getByText("Last 4 of SSN")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded")).not.toBeInTheDocument();
  });

  it("falls back to the embedded component for a legacy (express) account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...OWN_FORM_REQUIREMENTS, isApplicationCollected: false })),
    );
    render(<PayoutVerifySheet open onClose={vi.fn()} connectBase="/api/stripe/connect" />);
    expect(await screen.findByTestId("embedded")).toHaveTextContent("account_onboarding");
    expect(screen.queryByText("Last 4 of SSN")).not.toBeInTheDocument();
  });

  it("falls back to the embedded component when the spec cannot map a requirement key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...OWN_FORM_REQUIREMENTS, fallbackToEmbedded: true })),
    );
    render(<PayoutVerifySheet open onClose={vi.fn()} connectBase="/api/stripe/connect" />);
    expect(await screen.findByTestId("embedded")).toBeInTheDocument();
  });

  it("tokenizes SSN client-side via createToken('account', …) and never sends it as a plain field", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/identity") && (!init || init.method === undefined)) {
        return jsonResponse(OWN_FORM_REQUIREMENTS);
      }
      if (url.endsWith("/identity") && init?.method === "POST") {
        return jsonResponse({ status: "pending", fallbackToEmbedded: false });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PayoutVerifySheet open onClose={vi.fn()} connectBase="/api/stripe/connect" />);
    await screen.findByText("Legal name");

    fireEvent.change(document.querySelector('[data-attr="verify-field-individual.legal_name"]')!, {
      target: { value: "Prakrit Ramachandran" },
    });
    fireEvent.change(document.querySelector('[data-attr="verify-field-individual.ssn_last_4"]')!, {
      target: { value: "1234" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await vi.waitFor(() => expect(createTokenMock).toHaveBeenCalledTimes(1));
    const [tokenType, tokenPayload] = createTokenMock.mock.calls[0]!;
    expect(tokenType).toBe("account");
    expect(tokenPayload.individual.ssn_last_4).toBe("1234");

    await vi.waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    const body = JSON.parse((postCall[1] as RequestInit).body as string) as {
      accountToken?: string;
      fields?: Record<string, string>;
    };
    expect(body.accountToken).toBe("acct_tok_123");
    // The raw SSN digits must never appear anywhere in the plain-field payload.
    expect(JSON.stringify(body.fields ?? {})).not.toContain("1234");
  });
});
