// @vitest-environment jsdom
// The Message sheet (design-1112 §1): three steps in the public look, no email field, no subtext, phone required, a
// sent state with "Create account" (the personal link) and "Text us" (the configured line only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ListingMessageButton, ListingMessageForm, ListingTextUsLink } from "@/components/marketing/listing-message-sheet";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";

type Call = { url: string; body: Record<string, unknown> | null; method: string };
let calls: Call[];
let replies: Array<{ status: number; json: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ textCode: "BROOKLYN5" }), { status: 200 });
      const next = replies.shift() ?? { status: 200, json: { ok: true } };
      return new Response(JSON.stringify(next.json), { status: next.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const target = { propertyId: "prop-1", propertyLabel: "5259 Brooklyn", roomId: "r4", roomLabel: "Room 4" };
const LINE = { phone: "+12066781909", smsHref: "sms:+12066781909" };
const render_ = (ui: React.ReactNode, texting = LINE) => render(<PublicTextingProvider value={texting}>{ui}</PublicTextingProvider>);
const fill = () => {
  fireEvent.change(document.querySelector('[data-attr="listing-message-body"]')!, { target: { value: "Is it open Dec 1?" } });
  fireEvent.change(document.querySelector('[data-attr="listing-message-phone"]')!, { target: { value: "(206) 555-0142" } });
};
const press = (attr: string) => fireEvent.click(document.querySelector(`[data-attr="${attr}"]`)!);

describe("the form", () => {
  it("starts empty with a disabled Send, no email field, no account fields and no subtext", () => {
    render_(<ListingMessageForm target={target} />);
    const form = document.querySelector('[data-attr="listing-message-form"]')!;
    expect(form.querySelector('input[type="email"], input[type="password"]')).toBeNull();
    expect([...form.querySelectorAll("label span")].map((n) => n.textContent)).toEqual(["Message", "Phone", "First name"]);
    expect(form.querySelectorAll("p").length).toBe(0);
    expect(form.querySelector('[data-attr="listing-message-title"]')!.textContent).toBe("5259 Brooklyn · Room 4");
    expect((document.querySelector('[data-attr="listing-message-send"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("needs a message AND a phone before Send enables", () => {
    render_(<ListingMessageForm target={target} />);
    const send = document.querySelector('[data-attr="listing-message-send"]') as HTMLButtonElement;
    fireEvent.change(document.querySelector('[data-attr="listing-message-body"]')!, { target: { value: "Hi" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-attr="listing-message-phone"]')!, { target: { value: "206" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-attr="listing-message-phone"]')!, { target: { value: "(206) 555-0142" } });
    expect(send.disabled).toBe(false);
  });

  it("goes compose -> code -> sent, sending the room with the code request and the code with the send", async () => {
    replies.push({ status: 200, json: { ok: true } }, { status: 200, json: { ok: true, accountUrl: "https://proplane.test/l/tok" } });
    render_(<ListingMessageForm target={target} />);
    fill();
    press("listing-message-send");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-code"]')).not.toBeNull());
    expect(calls.filter((c) => c.method === "POST")[0]!.body).toMatchObject({ action: "send_code", propertyId: "prop-1", roomId: "r4", phone: "(206) 555-0142", body: "Is it open Dec 1?" });
    const verify = document.querySelector('[data-attr="listing-message-verify"]') as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-attr="listing-message-code"]')!, { target: { value: "123456" } });
    press("listing-message-verify");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-sent"]')).not.toBeNull());
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toMatchObject({ action: "verify_send", otp: "123456" });
    expect(screen.getByText("Message sent")).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-message-create-account"]')!.getAttribute("href")).toBe("https://proplane.test/l/tok");
  });

  it("the sent state offers Text us to the configured line only, prefilled with the home, room and code", async () => {
    replies.push({ status: 200, json: { ok: true } }, { status: 200, json: { ok: true } });
    render_(<ListingMessageForm target={target} />);
    fill();
    press("listing-message-send");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-code"]')).not.toBeNull());
    fireEvent.change(document.querySelector('[data-attr="listing-message-code"]')!, { target: { value: "123456" } });
    press("listing-message-verify");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-text-us"]')).not.toBeNull());
    await waitFor(() => expect(decodeURIComponent(document.querySelector('[data-attr="listing-message-text-us"]')!.getAttribute("href")!)).toContain("(BROOKLYN5)"));
    const href = decodeURIComponent(document.querySelector('[data-attr="listing-message-text-us"]')!.getAttribute("href")!);
    expect(href.startsWith("sms:+12066781909?&body=")).toBe(true);
    expect(href).toContain("5259 Brooklyn, Room 4");
    // No account link when the server minted none.
    expect(document.querySelector('[data-attr="listing-message-create-account"]')).toBeNull();
  });

  it("a signed-in visitor's own phone skips the code step", async () => {
    replies.push({ status: 200, json: { ok: true, skipCode: true } }, { status: 200, json: { ok: true } });
    render_(<ListingMessageForm target={target} />);
    fill();
    press("listing-message-send");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-sent"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="listing-message-code"]')).toBeNull();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body!.action)).toEqual(["send_code", "verify_send"]);
  });

  it("shows the server's error and stays on the step; a network failure reads as a connection problem", async () => {
    replies.push({ status: 429, json: { error: "Too many codes were sent to this number. Try again in an hour." } });
    render_(<ListingMessageForm target={target} />);
    fill();
    press("listing-message-send");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many codes"));
    expect(document.querySelector('[data-attr="listing-message-code"]')).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    press("listing-message-send");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not reach PropLane"));
  });

  it("a wrong code keeps the code step and says so", async () => {
    replies.push({ status: 200, json: { ok: true } }, { status: 400, json: { error: "That code did not work." } });
    render_(<ListingMessageForm target={target} />);
    fill();
    press("listing-message-send");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-message-code"]')).not.toBeNull());
    fireEvent.change(document.querySelector('[data-attr="listing-message-code"]')!, { target: { value: "000000" } });
    press("listing-message-verify");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That code did not work."));
    expect(document.querySelector('[data-attr="listing-message-code"]')).not.toBeNull();
  });
});

describe("the trigger and Text us", () => {
  it("Message opens the sheet as a dialog and Escape closes it", async () => {
    render_(<ListingMessageButton target={target} className="ps-btn">Message</ListingMessageButton>);
    expect(screen.queryByRole("dialog")).toBeNull();
    press("listing-message");
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(document.querySelector(".ps.ps-msg-overlay")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Text us is not drawn when no number is configured", () => {
    render_(<ListingTextUsLink propertyId="prop-1" label="5259 Brooklyn" className="ps-btn" />, { phone: null, smsHref: null });
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("Text us is an sms: link to exactly the configured line", () => {
    render_(<ListingTextUsLink propertyId="prop-1" label="5259 Brooklyn" roomLabel="Room 4" className="ps-btn" />);
    const hrefs = [...document.querySelectorAll('a[href^="sms:"]')].map((a) => a.getAttribute("href")!);
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]!.startsWith("sms:+12066781909?&body=")).toBe(true);
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });
});
