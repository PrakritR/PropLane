// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) =>
    open ? (
      <div>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/ui/checkbox-multi-select", () => ({
  CheckboxMultiSelect: ({
    label,
    options,
    groups,
    onChange,
  }: {
    label: string;
    options?: Array<{ value: string }>;
    groups?: Array<{ options: Array<{ value: string }> }>;
    onChange: (next: string[]) => void;
  }) => {
    const first = options?.[0]?.value ?? groups?.[0]?.options[0]?.value;
    return (
      <button type="button" onClick={() => first && onChange([first])}>
        {label}
      </button>
    );
  },
}));

import { ManagerSmsComposeModal } from "@/components/portal/manager-sms-compose-modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ManagerSmsComposeModal idempotency", () => {
  it("sends an attempt key and keeps an unknown outcome open with do-not-resend copy", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          code: "delivery_outcome_unknown",
          error: "The provider outcome could not be confirmed.",
          status: "unknown",
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ManagerSmsComposeModal
        open
        onClose={vi.fn()}
        residents={[
          {
            residentUserId: "resident-1",
            residentEmail: "resident@example.com",
            name: "Resident One",
            phone: "+12065550123",
            propertyLabel: "Unit 1",
            tenancyStatus: "resident",
            messages: [],
          },
        ]}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.click(screen.getByRole("button", { name: "To" }));
    fireEvent.click(screen.getByRole("button", { name: "Which people" }));
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send SMS" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Do not resend this message/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /operator review.*check the conversation later/i,
    );
    expect(screen.getByRole("button", { name: "Send SMS" })).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders["Idempotency-Key"]).toMatch(
      /^manual_[A-Za-z0-9_-]+_0$/,
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/try again/i),
    );
  });
});
