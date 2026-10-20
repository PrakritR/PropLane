// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MARKETING_REDIRECTS } from "@/lib/seo/marketing-routes";
import { GET as getLlms } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";
import {
  MANAGED_FAQ,
  MANAGED_INCLUDES,
  MANAGED_PRICE_HEADLINE,
  MANAGED_SERVICE_TOPIC,
} from "@/lib/marketing/managed-service";
import {
  PENDING_METRICS,
  TRACK_RECORD,
  trackRecordMetrics,
} from "@/lib/marketing/track-record";
import {
  MANAGED_SERVICE_FORM_ENDPOINT,
  ManagedServiceForm,
  composeManagedServiceMessage,
} from "@/components/marketing/site/managed-service-form";
import { OccupancyDots } from "@/components/marketing/site/track-record-band";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// The /pricing/service and /why-proplane pages these used to include are gone: the home page's own service
// and pricing sections carry that content, and they are held to the same no-invented-figure rule.
const NEW_FILES = [
  "src/components/marketing/site/pricing-cards.tsx",
  "src/components/marketing/site/managed-service-sections.tsx",
  "src/components/marketing/site/track-record-band.tsx",
  "src/components/marketing/home-pricing-compare.tsx",
  "src/components/marketing/home-pricing-compare-data.ts",
  "src/lib/marketing/managed-service.ts",
  "src/lib/marketing/track-record.ts",
];

describe("managed service never invents a price or a metric", () => {
  it("has no dollar figure or percent of its own in any new marketing file (only the Free plan's $0)", () => {
    for (const f of NEW_FILES) {
      const code = stripComments(read(f));
      const dollars = (code.match(/\$\d[\d,.]*/g) ?? []).filter(
        (d) => d !== "$0",
      );
      expect(dollars, `${f} hardcodes a dollar figure`).toEqual([]);
      expect(
        code.match(/(?<![\w\[(\-.])\d+(\.\d+)?\s?%/g) ?? [],
        `${f} hardcodes a percent`,
      ).toEqual([]);
    }
  });

  it("the managed price is Custom", () => {
    expect(MANAGED_PRICE_HEADLINE).toBe("Custom");
  });

  it("pricing cards read the rate card for the software plans", () => {
    const src = read("src/components/marketing/site/pricing-cards.tsx");
    expect(src).toContain("RATE_CARD.");
    expect(src).toContain("MANAGER_PLAN_TIERS");
  });

  it("only the three stated track-record numbers render while the pending ones are empty", () => {
    expect(PENDING_METRICS.every((m) => m.value === "")).toBe(true);
    const metrics = trackRecordMetrics();
    expect(metrics.map((m) => m.value)).toEqual([
      String(TRACK_RECORD.homes),
      "26 of 28",
      "Six-figure profit",
    ]);
  });

  it("a pending metric appears once it has a value", () => {
    const filled = [
      { ...PENDING_METRICS[0]!, value: "12 minutes" },
      PENDING_METRICS[1]!,
    ];
    expect(trackRecordMetrics(filled).map((m) => m.value)).toContain(
      "12 minutes",
    );
    expect(trackRecordMetrics(filled)).toHaveLength(4);
  });

  it("the occupancy picture matches the figure beside it", () => {
    const { container } = render(<OccupancyDots />);
    const cells = container.querySelectorAll("[role=img] > span");
    expect(cells.length).toBe(TRACK_RECORD.roomsTotal);
    expect(
      [...cells].filter((c) => c.className.includes("bg-[#2f5fd0]")).length,
    ).toBe(TRACK_RECORD.roomsOccupied);
    cleanup();
  });

  it("says services, never work orders, and names the six inclusions", () => {
    const text = JSON.stringify([MANAGED_INCLUDES, MANAGED_FAQ]).toLowerCase();
    expect(text).not.toContain("work order");
    expect(MANAGED_INCLUDES.map((i) => i.id)).toEqual([
      "leasing",
      "rent",
      "maintenance",
      "stays",
      "line",
      "reporting",
    ]);
  });

  it("the retained operating facts say six-figure profit exactly", () => {
    expect(TRACK_RECORD.profit.toLowerCase()).toBe("six-figure profit");
  });
});

describe("contact form", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("posts to the existing contact route under a topic that route's page offers", async () => {
    expect(MANAGED_SERVICE_FORM_ENDPOINT).toBe("/api/public/contact-message");
    // The home page's Contact section is the one send surface, and it mounts this very form.
    expect(read("src/app/(public)/page.tsx")).toContain("<ManagedServiceForm");
    expect(read("src/components/marketing/site/managed-service-form.tsx")).toContain(
      "topic: MANAGED_SERVICE_TOPIC",
    );
    expect(existsRoute("src/app/api/public/contact-message/route.ts")).toBe(
      true,
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagedServiceForm />);
    fireEvent.change(screen.getByLabelText(/name \*/i), {
      target: { value: "Jane Owner" },
    });
    fireEvent.change(screen.getByLabelText(/email \*/i), {
      target: { value: "jane@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/where is the home/i), {
      target: { value: "123 Main St, Seattle" },
    });
    fireEvent.click(screen.getByRole("button", { name: /talk to us/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/public/contact-message");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: "Jane Owner",
      email: "jane@example.com",
      topic: MANAGED_SERVICE_TOPIC,
    });
    expect(body.body).toContain("123 Main St, Seattle");
    await screen.findByText(/thanks, we have it/i);
  });

  it("refuses to send without a name, email and address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagedServiceForm />);
    fireEvent.click(screen.getByRole("button", { name: /talk to us/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("composes a plain-text message", () => {
    expect(
      composeManagedServiceMessage({
        phone: "",
        address: "A St",
        rooms: "4",
        kind: "",
        note: "Hi",
      }),
    ).toBe(
      "PropLane Managed inquiry\nHome: A St\nRooms: 4\nRental type: not given\nPhone: not given\n\nHi",
    );
  });
});

function existsRoute(rel: string): boolean {
  try {
    readFileSync(join(process.cwd(), rel), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("crawl surfaces include the managed service", () => {
  it("llms.txt links the service page and the track record", async () => {
    const body = await getLlms().text();
    expect(body).toContain("/#service");
    expect(body).toContain(
      `${TRACK_RECORD.roomsOccupied} of ${TRACK_RECORD.roomsTotal}`,
    );
    expect(body).toContain("PropLane Managed");
  });

  it("the sitemap lists home as the canonical service page", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain("https://proplane.ai/");
    expect(urls).not.toContain("https://proplane.ai/pricing/service");
    expect(urls).not.toContain("https://proplane.ai/why-proplane");
  });

  it("/service redirects to the home service section", () => {
    expect(MARKETING_REDIRECTS).toContainEqual({
      source: "/service",
      destination: "/#service",
      statusCode: 307,
    });
  });
});

describe("Swiss homepage inquiry", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("uses the existing route, preserves inputs on failure, and sends the selected home count on retry", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", send);
    render(<ManagedServiceForm variant="swiss" attrPrefix="home-contact" />);
    expect(screen.getByRole("button", { name: "Fewer homes" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Sample Owner" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "More homes" }));
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Two homes in Seattle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Message")).toHaveValue(
      "Two homes in Seattle",
    );
    expect(screen.getByLabelText("Number of homes")).toHaveValue(2);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("status");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe(MANAGED_SERVICE_FORM_ENDPOINT);
    expect(JSON.parse(send.mock.calls[1][1].body)).toEqual({
      name: "Sample Owner",
      email: "owner@example.com",
      topic: MANAGED_SERVICE_TOPIC,
      body: "PropLane Managed inquiry\nNumber of homes: 2\n\nTwo homes in Seattle",
    });
  });
});
