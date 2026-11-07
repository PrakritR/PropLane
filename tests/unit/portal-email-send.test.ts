import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));

const SENDER = "3f9a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8";
const ENV = ["RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_DOMAIN", "RESEND_INBOUND_WEBHOOK_SECRET"] as const;
const SECRET = `whsec_${Buffer.from("portal-email-send-test-key").toString("base64")}`;

type SentRequest = { url: string; body: unknown };

function mockFetch(respond: (url: string, body: unknown) => Response) {
  const requests: SentRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    requests.push({ url, body });
    return respond(url, body);
  });
  return requests;
}

describe("sendPortalConversationEmails", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV) saved.set(k, process.env[k]);
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM = "PropLane <portal@prop-lane.space>";
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    for (const k of ENV) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  const send = (toEmails: string[]) =>
    sendPortalConversationEmails({ senderUserId: SENDER, toEmails, subject: "s", text: "t", html: "<p>t</p>" });

  it("single recipient: /emails payload carries reply_to + threading anchor", async () => {
    const requests = mockFetch(() => Response.json({ id: "re_1" }));
    const results = await send(["resident@example.com"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.resend.com/emails");
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.to).toEqual(["resident@example.com"]);
    expect(String(body.reply_to)).toMatch(/^reply\+.+@in\.prop-lane\.space$/);
    const headers = body.headers as Record<string, string>;
    expect(headers["In-Reply-To"]).toMatch(/^<pl-anchor-[0-9a-f]{24}@prop-lane\.space>$/);
    expect(headers.References).toBe(headers["In-Reply-To"]);
    expect(results.get("resident@example.com")).toEqual({ sent: true, resendId: "re_1" });
  });

  it("multiple recipients: one /emails/batch call, one personalized payload each", async () => {
    const requests = mockFetch(() =>
      Response.json({ data: [{ id: "re_a" }, { id: "re_b" }] }),
    );
    const results = await send(["a@example.com", "b@example.com"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.resend.com/emails/batch");
    const payloads = requests[0]!.body as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    // Never a shared to: array — each recipient sees only themselves.
    expect(payloads[0]!.to).toEqual(["a@example.com"]);
    expect(payloads[1]!.to).toEqual(["b@example.com"]);
    expect(payloads[0]!.reply_to).not.toBe(payloads[1]!.reply_to);
    expect(results.get("a@example.com")).toEqual({ sent: true, resendId: "re_a" });
    expect(results.get("b@example.com")).toEqual({ sent: true, resendId: "re_b" });
  });

  it("chunks batches of more than 100 recipients", async () => {
    const requests = mockFetch((url, body) =>
      Response.json({ data: (body as unknown[]).map((_, i) => ({ id: `re_${i}` })) }),
    );
    const emails = Array.from({ length: 150 }, (_, i) => `r${i}@example.com`);
    const results = await send(emails);

    expect(requests).toHaveLength(2);
    expect((requests[0]!.body as unknown[]).length).toBe(100);
    expect((requests[1]!.body as unknown[]).length).toBe(50);
    expect([...results.values()].every((r) => r.sent)).toBe(true);
  });

  it("preserves the workspace From identity and personalized batch threading", async () => {
    const requests = mockFetch(() => Response.json({ data: [{ id: "a" }, { id: "b" }] }));
    await sendPortalConversationEmails({ senderUserId: SENDER, toEmails: ["a@example.com", "b@example.com"],
      subject: "Service reply", text: "Reply text", html: "<p>Reply text</p>",
      fromAddress: "Workspace <work@workspace.example>", threadingKey: "service-one" });
    const payloads = requests[0]!.body as Array<Record<string, unknown>>;
    expect(payloads).toEqual([
      expect.objectContaining({ from: "Workspace <work@workspace.example>", to: ["a@example.com"], subject: "Service reply", text: "Reply text", html: "<p>Reply text</p>" }),
      expect.objectContaining({ from: "Workspace <work@workspace.example>", to: ["b@example.com"], subject: "Service reply", text: "Reply text", html: "<p>Reply text</p>" }),
    ]);
    for (const payload of payloads) {
      const headers = payload.headers as Record<string, string>;
      expect(headers["In-Reply-To"]).toMatch(/^<pl-anchor-[0-9a-f]{24}@workspace\.example>$/);
      expect(headers.References).toBe(headers["In-Reply-To"]);
    }
    expect(payloads[0]!.headers).not.toEqual(payloads[1]!.headers);
  });

  it("keeps failed batch chunks unsent while retaining successful chunk IDs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    mockFetch((_url, body) => ++calls === 1 ? new Response("unavailable", { status: 503 })
      : Response.json({ data: (body as unknown[]).map((_, i) => ({ id: `second_${i}` })) }));
    const emails = Array.from({ length: 150 }, (_, i) => `r${i}@example.com`);
    const results = await send(emails);
    expect(emails.slice(0, 100).map(email => results.get(email))).toEqual(Array.from({ length: 100 }, () => ({ sent: false, resendId: null })));
    expect(emails.slice(100).map(email => results.get(email))).toEqual(Array.from({ length: 50 }, (_, i) => ({ sent: true, resendId: `second_${i}` })));
  });

  it("omits reply_to when RESEND_REPLY_DOMAIN is unset, keeps sending", async () => {
    delete process.env.RESEND_REPLY_DOMAIN;
    const requests = mockFetch(() => Response.json({ id: "re_1" }));
    const results = await send(["resident@example.com"]);

    const body = requests[0]!.body as Record<string, unknown>;
    expect("reply_to" in body).toBe(false);
    expect((body.headers as Record<string, string>).References).toBeTruthy();
    expect(results.get("resident@example.com")?.sent).toBe(true);
  });

  it("marks recipients unsent on HTTP failure or thrown fetch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(() => new Response("boom", { status: 500 }));
    expect((await send(["a@example.com"])).get("a@example.com")).toEqual({ sent: false, resendId: null });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect((await send(["a@example.com"])).get("a@example.com")).toEqual({ sent: false, resendId: null });
  });

  it("sends nothing without RESEND_API_KEY", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const results = await send(["a@example.com"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results.get("a@example.com")?.sent).toBe(false);
  });
});
