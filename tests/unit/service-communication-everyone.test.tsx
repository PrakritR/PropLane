// @vitest-environment jsdom
//
// A service's Communication opens on "Everyone" (plan admin-money-1008, D9): one time-ordered timeline of the
// resident's and the vendor's turns about THIS service, every turn named by author and party, and a "To" picker
// so a reply goes to exactly one party's thread. The per-party tabs stay after it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type FixtureThread = Record<string, unknown>;
let threadRows: FixtureThread[] = [];

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadPersistedInbox: () => threadRows,
    syncPersistedInboxFromServer: async () => threadRows,
  };
});

import { ServiceCommunicationPane } from "@/components/portal/service-communication-pane";
import type { ServiceCommunicationPartyTab } from "@/lib/service-communication-scope";

const SVC = { kind: "service", id: "wo-1", label: "Kitchen faucet" };

const RESIDENT_THREAD: FixtureThread = {
  id: "t-res", folder: "inbox", from: "Liam Foster", email: "liam@example.com", subject: "Faucet",
  preview: "", body: "The faucet drips.", time: "Sep 23, 10:41 AM", rootAt: "Sep 22, 8:12 AM", unread: false, recordRef: SVC,
  messages: [
    { id: "r2", from: "You", body: "Sorry, on it.", at: "Sep 22, 8:40 AM", outbound: true },
    { id: "r3", from: "Liam Foster", body: "Home Thursday.", at: "Sep 23, 10:41 AM", outbound: false },
  ],
};
const VENDOR_THREAD: FixtureThread = {
  id: "t-ven", folder: "inbox", from: "Pacific Plumbing", email: "pacific@example.com", subject: "Faucet",
  preview: "", body: "Can you quote a repair?", time: "Sep 22, 1:05 PM", rootAt: "Sep 22, 8:46 AM", rootOutbound: true, unread: false, recordRef: SVC,
  messages: [{ id: "v2", from: "Pacific Plumbing", body: "Can you send a photo?", at: "Sep 22, 1:05 PM", outbound: false }],
};
const RENT_THREAD: FixtureThread = {
  id: "t-rent", folder: "inbox", from: "Liam Foster", email: "liam@example.com", subject: "Rent", preview: "",
  body: "Rent is due Friday.", time: "Sep 20, 9:00 AM", unread: false, recordRef: { kind: "payment", id: "ch-1", label: "Rent" },
};

const PARTIES: ServiceCommunicationPartyTab[] = [
  { id: "resident", kind: "resident", name: "Liam Foster", email: "liam@example.com", phone: "(206) 555-0101" },
  { id: "vendor:d1", kind: "vendor", name: "Pacific Plumbing", email: "pacific@example.com" },
];

let sendBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  threadRows = [RENT_THREAD, VENDOR_THREAD, RESIDENT_THREAD];
  sendBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("send-inbox-message")) {
        sendBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderPane = (parties: readonly ServiceCommunicationPartyTab[] = PARTIES) =>
  render(<ServiceCommunicationPane recordId="wo-1" recordLabel="Kitchen faucet" parties={parties} />);

const pickTo = (optionName: string) => {
  fireEvent.click(document.querySelector('[data-attr="service-communication-to-select"]')!);
  const option = within(screen.getByRole("listbox", { name: "To" })).getByRole("option", { name: optionName });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
};
const tabLabels = () => [...document.querySelectorAll('[data-attr^="service-communication-tab-"]')].map((t) => t.textContent?.trim());
const write = (text: string) => {
  fireEvent.change(document.querySelector('[data-attr="record-communication-composer"] textarea, textarea')!, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("Everyone", () => {
  it("is the first and default tab, ahead of one tab per party", async () => {
    renderPane();
    await screen.findByText("Home Thursday.");
    expect(tabLabels()).toEqual(["Everyone", "Liam Foster", "Pacific Plumbing"]);
    expect(await screen.findByText("Home Thursday.")).toBeInTheDocument();
    expect(document.querySelector('[data-attr="service-communication-to"]')).not.toBeNull();
  });

  it("merges the resident's and the vendor's turns in time order, each named by author and party, and leaves the rent thread out", async () => {
    renderPane();
    await screen.findByText("Home Thursday.");
    const bodies = [...document.querySelectorAll("p.whitespace-pre-wrap")].map((p) => p.textContent);
    expect(bodies).toEqual(["The faucet drips.", "Sorry, on it.", "Can you quote a repair?", "Can you send a photo?", "Home Thursday."]);
    expect(screen.queryByText("Rent is due Friday.")).toBeNull();
    const names = [...document.querySelectorAll("[data-inbox-author]")].map((el) => `${el.textContent}${el.parentElement?.querySelector("[data-inbox-author-note]")?.textContent ?? ""}`.replace(/\s+/g, " "));
    expect(names).toEqual([
      "Liam Foster· Resident",
      "You· to Liam Foster",
      "You· to Pacific Plumbing",
      "Pacific Plumbing· Vendor",
      "Liam Foster· Resident",
    ]);
  });

  it("a party's own tab shows only that party's thread", async () => {
    renderPane();
    await screen.findByText("Home Thursday.");
    fireEvent.click(document.querySelector('[data-attr="service-communication-tab-vendor:d1"]')!);
    await screen.findByText("Can you send a photo?");
    expect(screen.queryByText("Home Thursday.")).toBeNull();
    expect(document.querySelector('[data-attr="service-communication-to"]')).toBeNull();
  });

  it("a reply To the resident goes to exactly the resident, stamped with this service", async () => {
    renderPane();
    await screen.findByText("Home Thursday.");
    write("See you Thursday");
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ toEmails: ["liam@example.com"], recordRef: { kind: "service", id: "wo-1" }, text: "See you Thursday" });
  });

  it("a reply To Pacific Plumbing goes to exactly the vendor, never the resident", async () => {
    renderPane();
    await screen.findByText("Home Thursday.");
    pickTo("Pacific Plumbing · Vendor");
    await waitFor(() => expect(screen.getByPlaceholderText("Write to Pacific Plumbing…")).toBeInTheDocument());
    write("Photo attached");
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ toEmails: ["pacific@example.com"], recordRef: { kind: "service", id: "wo-1" }, text: "Photo attached" });
    expect(JSON.stringify(sendBodies[0])).not.toContain("liam@example.com");
  });

  it("an add-on's vendor reply is stamped with its linked vendor job; the resident's with the add-on", async () => {
    render(<ServiceCommunicationPane recordId="SR-1" linkedWorkOrderId="wo-1" recordLabel="Storage locker" parties={PARTIES} />);
    await screen.findByText("Home Thursday.");
    pickTo("Pacific Plumbing · Vendor");
    write("Quote please");
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ toEmails: ["pacific@example.com"], recordRef: { kind: "service", id: "wo-1" } });
  });

  it("a service with only the resident has no Everyone tab - just the resident's thread", async () => {
    renderPane([PARTIES[0]!]);
    await screen.findByText("Home Thursday.");
    expect(tabLabels()).not.toContain("Everyone");
    expect(document.querySelector('[data-attr="service-communication-to"]')).toBeNull();
  });
});

describe("a later job with the same vendor", () => {
  it("shows its own turns on the new service and not the first job's", async () => {
    // The vendor's thread was opened for wo-A (and kept that recordRef); the manager wrote about wo-B in it.
    threadRows = [
      {
        ...VENDOR_THREAD,
        recordRef: { kind: "service", id: "wo-A", label: "Sink" },
        body: "Sink job quote?",
        messages: [
          { id: "a2", from: "Pacific Plumbing", body: "Sink fixed.", at: "Sep 2, 9:00 AM", outbound: false },
          { id: "b1", from: "You", body: "Faucet job: Thursday?", at: "Sep 22, 8:46 AM", outbound: true, recordRef: { kind: "service", id: "wo-B", label: "Faucet" } },
          { id: "b2", from: "Pacific Plumbing", body: "Thursday works.", at: "Sep 23, 10:02 AM", outbound: false, recordRef: { kind: "service", id: "wo-B", label: "Faucet" } },
        ],
      },
    ];
    render(<ServiceCommunicationPane recordId="wo-B" recordLabel="Faucet" parties={[PARTIES[1]!]} />);
    await screen.findByText("Thursday works.");
    expect(screen.getByText("Faucet job: Thursday?")).toBeInTheDocument();
    expect(screen.queryByText("Sink fixed.")).toBeNull();
    expect(screen.queryByText("Sink job quote?")).toBeNull();
    cleanup();
    render(<ServiceCommunicationPane recordId="wo-A" recordLabel="Sink" parties={[PARTIES[1]!]} />);
    await screen.findByText("Sink fixed.");
    expect(screen.queryByText("Thursday works.")).toBeNull();
  });
});
