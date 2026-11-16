// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GuestApplicationVerify } from "@/components/marketing/guest-application-verify";
import { GuestSignupContinue } from "@/components/public/guest-signup-continue";
import { GuestTourTextLink } from "@/components/marketing/guest-tour-text-link";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (over: Partial<RentalWizardFormState> = {}) => ({ propertyId: "prop-1", phone: "(206) 555-0142", email: "r@example.com", ...over }) as unknown as RentalWizardFormState;
const TOKEN = "T".repeat(43);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuestApplicationVerify choices", () => {
  it("offers a code, a texted link and an emailed link when there is a phone", () => {
    render(<GuestApplicationVerify form={form()} onBack={() => {}} />);
    expect(screen.getByText("Text me a code")).toBeTruthy();
    expect(screen.getByText("Text me a link")).toBeTruthy();
    expect(screen.getByText("Email me a link")).toBeTruthy();
  });

  it("with no phone only the emailed link is offered", () => {
    render(<GuestApplicationVerify form={form({ phone: "" } as Partial<RentalWizardFormState>)} onBack={() => {}} />);
    expect(screen.queryByText("Text me a code")).toBeNull();
    expect(screen.queryByText("Text me a link")).toBeNull();
    expect(screen.getByText("Email me a link")).toBeTruthy();
  });

  it("Text me a link holds the draft first, then asks for the link with the draft token and no phone", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, body });
      return url.includes("application-drafts") ? json(200, { ok: true, token: TOKEN }) : json(200, { ok: true });
    }));
    render(<GuestApplicationVerify form={form()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Text me a link"));
    await waitFor(() => expect(screen.getByText("Check your phone for your link.")).toBeTruthy());
    expect(calls.map((c) => c.url)).toEqual(["/api/public/application-drafts", "/api/public/guest-signup-link"]);
    expect(calls[1]!.body).toEqual({ kind: "apply", draftToken: TOKEN });
  });

  it("shows the refusal and stays on the choices when the text cannot go", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("application-drafts") ? json(200, { ok: true, token: TOKEN }) : json(502, { error: "We could not text that number. Use a code or email instead." }))));
    render(<GuestApplicationVerify form={form()} onBack={() => {}} />);
    fireEvent.click(screen.getByText("Text me a link"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Use a code or email"));
    expect(screen.getByText("Text me a code")).toBeTruthy();
  });
});

describe("GuestTourTextLink", () => {
  it("has one primary Text me a link button, the emailed link and sign in, and posts only the inquiry id", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<GuestTourTextLink inquiryId="inq-1" createAccountHref="/auth/create-account" signInHref="/auth/sign-in" />);
    expect(container.querySelectorAll(".ps-btn-blue")).toHaveLength(1);
    expect(screen.getByText("Use email").getAttribute("href")).toBe("/auth/create-account");
    fireEvent.click(screen.getByText("Text me a link"));
    await waitFor(() => expect(screen.getByText("Check your phone for your link.")).toBeTruthy());
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ kind: "tour", tourInquiryId: "inq-1" });
  });
});

describe("GuestSignupContinue", () => {
  it("posts to the link's own route and goes where the server says", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    const fetchMock = vi.fn(async () => json(200, { ok: true, nextPath: "/resident/applications/apply?propertyId=prop-1" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GuestSignupContinue token="tok_123" kind="apply" houseLabel="5259 Brooklyn" maskedPhone="•••• 0142" />);
    expect(screen.getByText("Finish your application: 5259 Brooklyn")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/resident/applications/apply?propertyId=prop-1"));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/l/tok_123/guest-signup");
  });

  it("an expired link shows the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "This link has expired." })));
    render(<GuestSignupContinue token="tok" kind="tour" houseLabel="" maskedPhone="•••• 0142" />);
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This link has expired."));
  });
});
