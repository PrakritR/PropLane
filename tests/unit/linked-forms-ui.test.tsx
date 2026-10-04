// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

const client = vi.hoisted(() => ({
  fetchLinkedFormsForApplication: vi.fn(),
  fetchMyLinkedForms: vi.fn(),
  mintLinkedFormShareUrl: vi.fn(),
  sendLinkedFormByEmail: vi.fn(),
  markLinkedFormNotNeededClient: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/linked-form-requests-client", () => client);
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => toast }));

import { RentalApplicationFinishPanel } from "@/components/marketing/rental-application-finish-panel";
import { ApplicationLinkedFormsSection } from "@/components/portal/application-linked-forms-section";
import { ResidentLinkedFormsSection } from "@/components/portal/resident-linked-forms-section";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(navigator, "share");
});

const TOKEN = "S".repeat(43);

function view(overrides: Partial<LinkedFormRequestView> = {}): LinkedFormRequestView {
  return {
    id: "req-1",
    applicationId: "PROPLANE-APP00001",
    ruleId: "r",
    formKind: "application",
    formId: "cosigner-form",
    formLabel: "Co-signer form",
    questionCount: 12,
    sourceQuestionLabel: "Co-signer planned",
    sourceAnswerLabel: "Yes",
    neededBeforeReview: true,
    status: "owed",
    feeCents: 4500,
    feePaid: false,
    completedAt: null,
    applicantName: "Ava Lee",
    viewerRole: "manager",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

const issued = [
  { ...view(), shareToken: TOKEN, sharePath: `/f/${TOKEN}`, viewerRole: "applicant" as const },
  view({ id: "req-2", formKind: "move_in", formId: "mif-pets", formLabel: "Pet agreement", questionCount: 6, feeCents: null, neededBeforeReview: false, viewerRole: "applicant" }),
];

describe("the applicant's finish screen", () => {
  it("lists the forms still owed instead of the co-signer copy box", () => {
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="ava@example.com" portalFlow hasCosigner="yes" linkedForms={issued} onDone={() => {}} />);
    expect(screen.getByRole("heading", { name: "2 more forms to finish" })).toBeInTheDocument();
    const rows = screen.getAllByText(/^(Co-signer form|Pet agreement)$/);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("12 questions")).toBeInTheDocument();
    expect(screen.getByText("$45 fee")).toBeInTheDocument();
    expect(screen.getByText("No fee")).toBeInTheDocument();
    expect(screen.queryByText(/Co-signer invite/i)).not.toBeInTheDocument();
  });

  it("offers Fill out now on every form, and 'someone else' only where a link can be shared", () => {
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="" portalFlow linkedForms={issued} onDone={() => {}} />);
    const fill = screen.getAllByRole("link", { name: "Fill out now" });
    expect(fill.map((link) => link.getAttribute("href"))).toEqual([`/f/${TOKEN}`, "/resident/move-in"]);
    expect(screen.getAllByRole("button", { name: "Someone else will fill it in" })).toHaveLength(1);
  });

  it("reveals the link with Copy link, and Share… only where the device can share", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="" portalFlow linkedForms={issued} onDone={() => {}} />);

    expect(screen.queryByText(new RegExp(`/f/${TOKEN}`))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Someone else will fill it in" }));
    const link = await screen.findByText(new RegExp(`/f/${TOKEN}$`));
    expect(link.textContent).toContain(window.location.origin);
    expect(screen.queryByRole("button", { name: "Share…" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/f/${TOKEN}`));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    // The just-submitted link is already known: nothing is minted, and nothing is sent from the resident side.
    expect(client.mintLinkedFormShareUrl).not.toHaveBeenCalled();
    expect(screen.queryByText(/work (number|email)/i)).not.toBeInTheDocument();
  });

  it("shows Share… when the browser can share, and shares the link", async () => {
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="" portalFlow linkedForms={[issued[0]!]} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Someone else will fill it in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share…" }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: "Co-signer form", url: `${window.location.origin}/f/${TOKEN}` }));
  });

  it("keeps the old co-signer copy box when the template links no form", () => {
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="" portalFlow hasCosigner="yes" linkedForms={[]} onDone={() => {}} />);
    expect(screen.getByText(/Co-signer invite/i)).toBeInTheDocument();
    expect(screen.queryByText(/more forms? to finish/i)).not.toBeInTheDocument();
  });

  it("a finished form is not on the list", () => {
    render(<RentalApplicationFinishPanel axisId="PROPLANE-APP00001" email="" portalFlow linkedForms={[{ ...issued[0]!, status: "done" }, issued[1]!]} onDone={() => {}} />);
    expect(screen.getByRole("heading", { name: "1 more form to finish" })).toBeInTheDocument();
  });
});

describe("the resident portal's Applications section", () => {
  it("lists 'Forms for <applicant>' for a helper, without a way to pass the form on", async () => {
    client.fetchMyLinkedForms.mockResolvedValue({
      own: [view({ viewerRole: "applicant" })],
      helping: [view({ id: "req-9", applicationId: "PROPLANE-OTHER", applicantName: "Sam Park", formLabel: "Guarantor form", viewerRole: "helper" })],
    });
    render(<ResidentLinkedFormsSection />);
    expect(await screen.findByRole("heading", { name: "1 more form to finish" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Forms for Sam Park" })).toBeInTheDocument();
    const helperList = screen.getByRole("heading", { name: "Forms for Sam Park" }).closest("section")!;
    expect(within(helperList).queryByRole("button", { name: "Someone else will fill it in" })).not.toBeInTheDocument();
    expect(within(helperList).getByRole("link", { name: "Fill out now" })).toHaveAttribute("href", "/f/open/req-9");
  });

  it("draws nothing when nothing is owed", async () => {
    client.fetchMyLinkedForms.mockResolvedValue({ own: [], helping: [] });
    const { container } = render(<ResidentLinkedFormsSection />);
    await waitFor(() => expect(client.fetchMyLinkedForms).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });

  it("asks the server for a link when the form came from the portal (no token held)", async () => {
    client.fetchMyLinkedForms.mockResolvedValue({ own: [view({ viewerRole: "applicant" })], helping: [] });
    client.mintLinkedFormShareUrl.mockResolvedValue({ ok: true, url: `http://localhost/f/${TOKEN}` });
    render(<ResidentLinkedFormsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Someone else will fill it in" }));
    expect(await screen.findByText(`http://localhost/f/${TOKEN}`)).toBeInTheDocument();
    expect(client.mintLinkedFormShareUrl).toHaveBeenCalledWith("req-1");
  });
});

describe("the manager's application record", () => {
  beforeEach(() => {
    client.fetchLinkedFormsForApplication.mockResolvedValue([
      view({ id: "r1", status: "owed" }),
      view({ id: "r2", formLabel: "Pet agreement", formKind: "move_in", sourceQuestionLabel: "Do you have pets?", neededBeforeReview: false, status: "shared", feeCents: null }),
      view({ id: "r3", formLabel: "Guarantor form", status: "done", completedAt: "2026-10-04T20:00:00Z", feeCents: 4500, feePaid: true, neededBeforeReview: true }),
    ]);
  });

  it("shows each form, where it came from, its status and fee, and the waiting fact", async () => {
    render(<ApplicationLinkedFormsSection applicationId="PROPLANE-APP00001" />);
    expect(await screen.findByRole("heading", { name: "Linked forms" })).toBeInTheDocument();
    expect(screen.getByText("Waiting on 1 form")).toBeInTheDocument();
    expect(screen.getAllByText("From “Co-signer planned” = Yes")).toHaveLength(2);
    expect(screen.getByText("From “Do you have pets?” = Yes")).toBeInTheDocument();
    expect(screen.getByText(/Waiting on applicant/)).toBeInTheDocument();
    expect(screen.getByText(/Link shared · not opened/)).toBeInTheDocument();
    expect(screen.getByText(/Completed Oct 4/)).toBeInTheDocument();
    expect(screen.getByText(/\$45 fee paid/)).toBeInTheDocument();
  });

  it("has the row menu only on forms still owed, with Copy link, Send from work email and Mark not needed", async () => {
    const user = userEvent.setup();
    render(<ApplicationLinkedFormsSection applicationId="PROPLANE-APP00001" />);
    await screen.findByRole("heading", { name: "Linked forms" });
    expect(screen.getAllByRole("button", { name: /Actions for/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Actions for Guarantor form" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for Co-signer form" }));
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Send from work email" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Mark not needed" })).toBeInTheDocument();
  });

  it("a move-in form has no share link, only Mark not needed", async () => {
    const user = userEvent.setup();
    render(<ApplicationLinkedFormsSection applicationId="PROPLANE-APP00001" />);
    await screen.findByRole("heading", { name: "Linked forms" });
    await user.click(screen.getByRole("button", { name: "Actions for Pet agreement" }));
    expect(await screen.findByRole("menuitem", { name: "Mark not needed" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Send from work email" })).not.toBeInTheDocument();
  });

  it("sends from the work email to a typed address, and marks a form not needed", async () => {
    const user = userEvent.setup();
    client.sendLinkedFormByEmail.mockResolvedValue({ ok: true });
    client.markLinkedFormNotNeededClient.mockResolvedValue({ ok: true });
    render(<ApplicationLinkedFormsSection applicationId="PROPLANE-APP00001" />);
    await screen.findByRole("heading", { name: "Linked forms" });

    await user.click(screen.getByRole("button", { name: "Actions for Co-signer form" }));
    await user.click(await screen.findByRole("menuitem", { name: "Send from work email" }));
    await user.type(await screen.findByLabelText("Email address to send the link to"), "mom@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(client.sendLinkedFormByEmail).toHaveBeenCalledWith("r1", "mom@example.com"));
    expect(toast.showToast).toHaveBeenCalledWith("Sent from your work email");

    await user.click(screen.getByRole("button", { name: "Actions for Pet agreement" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark not needed" }));
    await waitFor(() => expect(client.markLinkedFormNotNeededClient).toHaveBeenCalledWith("r2"));
  });

  it("draws nothing for an application that owes no forms", async () => {
    client.fetchLinkedFormsForApplication.mockResolvedValue([]);
    const { container } = render(<ApplicationLinkedFormsSection applicationId="PROPLANE-APP00001" />);
    await waitFor(() => expect(client.fetchLinkedFormsForApplication).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });
});
