import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import {
  messageAboutService,
  serviceCommunicationParties,
  serviceRecordIds,
  serviceReplyParty,
  serviceThreadParty,
  serviceThreadsForEveryone,
  serviceThreadsForParty,
  serviceTimeline,
  threadAboutService,
  type ServiceCommunicationPartyTab,
} from "@/lib/service-communication-scope";
import { serviceRecordRefForEvent } from "@/lib/service-record-ref";

/**
 * A service's Communication section is about THIS service (plan D9): one tab per party, each showing only the
 * threads stamped with the service's recordRef - not the person-wide history matched by email or phone.
 */
const thread = (id: string, email: string, ref?: { kind: string; id: string; label?: string }) => ({
  id,
  email,
  smsNoticePhone: null as string | null,
  ...(ref ? { recordRef: { label: "Storage locker", ...ref } } : {}),
});

describe("serviceThreadsForParty", () => {
  const resident = { email: "liam@example.com" };
  const vendor = { email: "pacific@example.com" };
  const threads = [
    thread("t-service", "liam@example.com", { kind: "service", id: "SR-1" }),
    thread("t-rent", "liam@example.com", { kind: "payment", id: "ch-9", label: "Rent" }),
    thread("t-unstamped", "liam@example.com"),
    thread("t-job", "pacific@example.com", { kind: "service", id: "SR-1-vendor-job" }),
    thread("t-other-service", "liam@example.com", { kind: "service", id: "SR-2" }),
  ];

  it("shows only the threads stamped with this service, never the resident's rent notices or other chats", () => {
    const shown = serviceThreadsForParty(threads, { recordIds: ["SR-1"], party: resident });
    expect(shown.map((t) => t.id)).toEqual(["t-service"]);
  });

  it("an add-on also shows its linked vendor job's thread, on the vendor's tab only", () => {
    const ids = serviceRecordIds("SR-1", "SR-1-vendor-job");
    expect(ids).toEqual(["SR-1", "SR-1-vendor-job"]);
    expect(serviceThreadsForParty(threads, { recordIds: ids, party: vendor }).map((t) => t.id)).toEqual(["t-job"]);
    expect(serviceThreadsForParty(threads, { recordIds: ids, party: resident }).map((t) => t.id)).toEqual(["t-service"]);
  });

  it("a thread that only shares the contact's email is not about the service, however recent", () => {
    expect(serviceThreadsForParty([thread("t", "liam@example.com")], { recordIds: ["SR-1"], party: resident })).toEqual([]);
  });

  it("a party with no email or phone sees every thread stamped to the service", () => {
    const shown = serviceThreadsForParty(threads, { recordIds: ["SR-1", "SR-1-vendor-job"], party: {} });
    expect(shown.map((t) => t.id)).toEqual(["t-service", "t-job"]);
  });

  it("a vendor is told apart by phone when the thread has no email", () => {
    const sms = { ...thread("t-sms", "", { kind: "service", id: "SR-1" }), smsNoticePhone: "+12065550101" };
    expect(serviceThreadsForParty([sms], { recordIds: ["SR-1"], party: { phone: "(206) 555-0101" } }).map((t) => t.id)).toEqual(["t-sms"]);
    expect(serviceThreadsForParty([sms], { recordIds: ["SR-1"], party: { phone: "(206) 555-0199" } })).toEqual([]);
  });
});

describe("serviceCommunicationParties", () => {
  const offers = [
    { vendorDirectoryId: "d1", vendorName: "Pacific Plumbing", vendorEmail: "pacific@example.com" },
    { vendorDirectoryId: "d2", vendorName: "Cascade Drains", vendorEmail: undefined },
  ];

  it("lists the resident first, then every vendor the job went to, once each", () => {
    const tabs = serviceCommunicationParties({
      resident: { name: "Liam Foster", email: "liam@example.com" },
      offers,
      bids: [{ vendorDirectoryId: "d1", vendorUserId: "u1", vendorName: "Pacific Plumbing", vendorEmail: undefined }],
      roster: [{ id: "d2", name: "Cascade Drains", email: "cascade@example.com", phone: "206-555-0102" }],
    });
    expect(tabs.map((t) => `${t.kind}:${t.name}`)).toEqual(["resident:Liam Foster", "vendor:Pacific Plumbing", "vendor:Cascade Drains"]);
    // A vendor with no email on the offer reads it from the roster.
    expect(tabs[2]).toMatchObject({ email: "cascade@example.com", phone: "206-555-0102" });
  });

  it("has no resident tab for a job with no resident, and only the resident before anything is sent", () => {
    expect(serviceCommunicationParties({ resident: null, offers }).map((t) => t.kind)).toEqual(["vendor", "vendor"]);
    expect(serviceCommunicationParties({ resident: { name: "Liam", email: "l@x.co" }, offers: [] }).map((t) => t.id)).toEqual(["resident"]);
  });
});

describe("a service notification is stamped with the service", () => {
  it("stamps work-order and add-on events with {kind: service, id} and never an invoice decision", () => {
    expect(serviceRecordRefForEvent("work_order", "wo-1", "Burst pipe")).toEqual({ kind: "service", id: "wo-1", label: "Burst pipe" });
    expect(serviceRecordRefForEvent("service_request", "SR-1")).toEqual({ kind: "service", id: "SR-1", label: "Service" });
    expect(serviceRecordRefForEvent("work_order", "invoice:inv-1")).toBeUndefined();
    expect(serviceRecordRefForEvent("payment", "ch-1")).toBeUndefined();
    expect(serviceRecordRefForEvent("work_order", "")).toBeUndefined();
  });

  it("is passed on by the delivery paths that carry offers, bids and visit times", () => {
    const events = readFileSync(join(process.cwd(), "src/lib/action-events.server.ts"), "utf8");
    expect(events.match(/serviceRecordRefForEvent\(/g)?.length).toBe(2);
    expect(events).toMatch(/recordRef: input\.recordRef/);
    expect(readFileSync(join(process.cwd(), "src/lib/work-order-notification.server.ts"), "utf8")).toMatch(/recordRef \? \{ recordRef \}/);
    expect(readFileSync(join(process.cwd(), "src/lib/vendor-notification-delivery.ts"), "utf8")).toMatch(/recordRef: serviceRef/);
  });
});

describe("the service Communication pane", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/service-communication-pane.tsx"), "utf8");
  it("scopes every tab to the service, links the full conversation and passes no person-wide contact matching", () => {
    expect(src).toMatch(/serviceScope=\{[^}]*scope\}/);
    expect(src).toContain("serviceEveryone={");
    expect(src).toContain("fullConversationHref");
    const section = readFileSync(join(process.cwd(), "src/components/portal/record-communication-section.tsx"), "utf8");
    expect(section).toContain("Open the full conversation in Communication");
    expect(section).toMatch(/if \(serviceScope\) \{/);
  });
});

/* ───────── Everyone: the union of the resident's and the vendors' threads (plan admin-money-1008, D9) ───────── */
const SVC = { kind: "service", id: "wo-1", label: "Kitchen faucet" };
const parties: ServiceCommunicationPartyTab[] = [
  { id: "resident", kind: "resident", name: "Liam Foster", email: "liam@example.com" },
  { id: "vendor:d1", kind: "vendor", name: "Pacific Plumbing", email: "pacific@example.com" },
];
const full = (over: Partial<PersistedInboxThread> & { id: string; email: string }): PersistedInboxThread =>
  ({
    folder: "inbox", from: over.email, subject: "", preview: "", body: "", time: "Sep 23, 10:41 AM", unread: false, ...over,
  }) as PersistedInboxThread;

describe("the Everyone view", () => {
  const residentThread = full({
    id: "t-res", email: "liam@example.com", from: "Liam Foster", recordRef: SVC as never,
    body: "The faucet drips.", rootAt: "Sep 22, 8:12 AM",
    messages: [
      { id: "r2", from: "You", body: "Sorry, on it.", at: "Sep 22, 8:40 AM", outbound: true },
      { id: "r3", from: "Liam Foster", body: "Home Thursday.", at: "Sep 23, 10:41 AM", outbound: false },
    ],
  });
  const vendorThread = full({
    id: "t-ven", email: "pacific@example.com", from: "Pacific Plumbing", recordRef: SVC as never,
    body: "Can you quote a repair?", rootAt: "Sep 22, 8:46 AM", rootOutbound: true,
    messages: [{ id: "v2", from: "Pacific Plumbing", body: "Send a photo?", at: "Sep 22, 1:05 PM", outbound: false }],
  });
  const rentThread = full({ id: "t-rent", email: "liam@example.com", recordRef: { kind: "payment", id: "ch-1", label: "Rent" } as never, body: "Rent due" });
  const strangerThread = full({ id: "t-x", email: "x@example.com", recordRef: SVC as never, body: "Hi" });
  const all = [rentThread, vendorThread, residentThread, strangerThread];

  it("is the union of every party's threads about this service, in inbox order, each once; rent and other chats stay out", () => {
    const shown = serviceThreadsForEveryone(all, { recordIds: ["wo-1"], parties });
    // The stranger is stamped with the service but is nobody on this job: a known party list only shows its own people.
    expect(shown.map((t) => t.id)).toEqual(["t-ven", "t-res"]);
  });

  it("with no party on file, every thread stamped with the service", () => {
    expect(serviceThreadsForEveryone(all, { recordIds: ["wo-1"], parties: [] }).map((t) => t.id)).toEqual(["t-ven", "t-res", "t-x"]);
  });

  it("orders every turn of every thread by time, whichever thread it lives in", () => {
    const timeline = serviceTimeline(all, { recordIds: ["wo-1"], parties });
    expect(timeline.map((e) => `${e.party?.name}:${e.message.body}`)).toEqual([
      "Liam Foster:The faucet drips.",
      "Liam Foster:Sorry, on it.",
      "Pacific Plumbing:Can you quote a repair?",
      "Pacific Plumbing:Send a photo?",
      "Liam Foster:Home Thursday.",
    ]);
  });

  it("tells which party a thread is with, by address", () => {
    expect(serviceThreadParty(vendorThread, parties)?.id).toBe("vendor:d1");
    expect(serviceThreadParty(strangerThread, parties)).toBeNull();
  });

  it("the To picker's choice names the party a reply goes to; an unknown id falls back to the resident", () => {
    expect(serviceReplyParty(parties, "vendor:d1")?.name).toBe("Pacific Plumbing");
    expect(serviceReplyParty(parties, "gone")?.id).toBe("resident");
    expect(serviceReplyParty([], "x")).toBeNull();
  });
});

describe("a later job with the same vendor", () => {
  // The vendor's thread was opened for job A and kept A's recordRef; a message about job B was stamped with B.
  const reused = full({
    id: "t-ven", email: "pacific@example.com", from: "Pacific Plumbing", recordRef: { kind: "service", id: "wo-A", label: "Sink" } as never,
    body: "Sink job", rootAt: "Sep 1, 9:00 AM", rootOutbound: true,
    messages: [
      { id: "a2", from: "Pacific Plumbing", body: "Sink fixed.", at: "Sep 2, 9:00 AM", outbound: false },
      { id: "b1", from: "You", body: "Faucet job: can you come Thursday?", at: "Sep 22, 8:46 AM", outbound: true, recordRef: { kind: "service", id: "wo-B", label: "Faucet" } },
      { id: "b2", from: "Pacific Plumbing", body: "Thursday works.", at: "Sep 23, 10:02 AM", outbound: false, recordRef: { kind: "service", id: "wo-B", label: "Faucet" } },
    ],
  });
  const vendor = { id: "vendor:d1", kind: "vendor" as const, name: "Pacific Plumbing", email: "pacific@example.com" };

  it("is found through its own turns even though the thread kept the first job's recordRef", () => {
    expect(threadAboutService(reused, new Set(["wo-B"]))).toBe(true);
    expect(threadAboutService(reused, new Set(["wo-A"]))).toBe(true);
    expect(threadAboutService(reused, new Set(["wo-C"]))).toBe(false);
    expect(serviceThreadsForParty([reused], { recordIds: ["wo-B"], party: vendor }).map((t) => t.id)).toEqual(["t-ven"]);
  });

  it("shows each job only its own turns", () => {
    const bodies = (id: string) =>
      serviceTimeline([reused], { recordIds: [id], parties: [vendor] }).map((e) => e.message.body);
    expect(bodies("wo-B")).toEqual(["Faucet job: can you come Thursday?", "Thursday works."]);
    expect(bodies("wo-A")).toEqual(["Sink job", "Sink fixed."]);
  });

  it("an unstamped turn belongs to the thread's own job; a stamped one answers for itself", () => {
    const ids = new Set(["wo-B"]);
    expect(messageAboutService(reused, { recordRef: undefined }, ids)).toBe(false);
    expect(messageAboutService(reused, { recordRef: { kind: "service", id: "wo-B", label: "Faucet" } }, ids)).toBe(true);
    expect(messageAboutService(reused, { recordRef: { kind: "payment", id: "wo-B", label: "Rent" } }, ids)).toBe(false);
  });
});

describe("a dispatch-agent thread is matched by its work order", () => {
  const agent = (over: Record<string, unknown>) => ({ id: "vendor_agent_wo-9_dir-1", email: "", ...over });
  it("by the stamped workOrderId, by the service recordRef, or by the id the session minted", () => {
    const ids = new Set(["wo-9"]);
    expect(threadAboutService(agent({ workOrderId: "wo-9" }), ids)).toBe(true);
    expect(threadAboutService(agent({ recordRef: { kind: "service", id: "wo-9", label: "Faucet" } }), ids)).toBe(true);
    // A thread written before the stamp existed still matches through the deterministic id.
    expect(threadAboutService(agent({}), ids)).toBe(true);
  });
  it("never matches another job's session, or a lookalike id", () => {
    expect(threadAboutService(agent({}), new Set(["wo-10"]))).toBe(false);
    expect(threadAboutService(agent({}), new Set(["wo"]))).toBe(false);
    expect(threadAboutService(agent({ id: "portal_wo-9" }), new Set(["wo-9"]))).toBe(false);
  });
});
