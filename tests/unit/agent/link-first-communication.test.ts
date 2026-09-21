import { describe, expect, it, vi } from "vitest";

/**
 * Link-first communication: every conversational agent sends the PropLane page
 * that answers the request (listing, tour, apply, payments, lease, invoices)
 * instead of walking the person through the flow by chat.
 */
vi.mock("@/lib/manager-property-share-access", () => ({
  getShareablePropertyForUser: vi.fn(async (_userId: string, propertyId: string) =>
    propertyId === "live-house" ? { id: "live-house", title: "Alder Row", adminPublishLive: true } : null,
  ),
}));

import {
  agentLinkOrigin,
  buildPropertyLinksForManager,
  getPropertyLinksTool,
  getResidentLinksTool,
  getVendorLinksTool,
  getVendorSmsLinksTool,
  residentLinks,
  residentLinkPaths,
  vendorLinks,
  vendorLinkPaths,
} from "@/lib/tools/domains/portal-links";
import { replyForIntent } from "@/lib/claw-leasing-bot.server";
import { AGENT_SYSTEM_PROMPTS } from "@/lib/agent/system-prompts";
import { LEASING_SMS_SYSTEM_PROMPT } from "@/lib/agent/leasing-sms-system-prompt";
import { SYSTEM_PROMPT as MANAGER_PROMPT } from "@/lib/agent/system-prompt";
import {
  agentRegistry,
  buildManagerSmsRegistry,
  leasingSmsAgentRegistry,
  vendorWorkOrderAgentRegistry,
} from "@/lib/tools";
import { buildResidentRegistry, residentAgentRegistry } from "@/lib/tools/resident-index";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { VendorAgentContext } from "@/lib/tools/vendor-context";
import { routeResolves } from "../../helpers/route-resolves";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";

const PROD = "https://prop-lane.space";

function residentCtx(channel?: ResidentAgentContext["channel"], phase: "application" | "approved" = "approved"): ResidentAgentContext {
  return {
    kind: "resident",
    userId: "res-1",
    email: "res@example.test",
    managerIds: ["mgr-1"],
    channel,
    phase,
    managerTier: "paid",
    landlordId: "res-1",
    db: {},
  } as unknown as ResidentAgentContext;
}

describe("link origins", () => {
  it("off-platform channels get absolute production links; the portal keeps relative paths", () => {
    expect(agentLinkOrigin()).toBe(PROD);
    expect(residentLinks("sms").payments).toBe(`${PROD}/resident/payments/pending`);
    expect(residentLinks("email").lease).toBe(`${PROD}/resident/lease`);
    expect(residentLinks(undefined).scheduleTour).toBe(`${PROD}/resident/tour/schedule`);
    expect(residentLinks("portal").payments).toBe("/resident/payments/pending");
    expect(vendorLinks("sms").invoices).toBe(`${PROD}/vendor/financials/invoices`);
    expect(vendorLinks("portal").profile).toBe("/vendor/profile");
    for (const url of [...Object.values(residentLinks("sms")), ...Object.values(vendorLinks("sms"))]) {
      expect(url).not.toMatch(/localhost|vercel\.app|axis-seattle/);
    }
  });

  it("every resident and vendor link path resolves to a real route", () => {
    for (const path of [...Object.values(residentLinkPaths()), ...Object.values(vendorLinkPaths())]) {
      expect(routeResolves(path), `${path} should resolve under src/app`).toBe(true);
    }
  });
});

describe("get_resident_links", () => {
  it("follows the context channel: SMS is absolute, portal is relative, unknown is absolute", async () => {
    const sms = await getResidentLinksTool.handler(residentCtx("sms"), {});
    expect(sms.channel).toBe("sms");
    expect(sms.links.payments).toBe(`${PROD}/resident/payments/pending`);
    const portal = await getResidentLinksTool.handler(residentCtx("portal"), {});
    expect(portal.links.lease).toBe("/resident/lease");
    const unknown = await getResidentLinksTool.handler(residentCtx(undefined), {});
    expect(unknown.links.services).toBe(`${PROD}/resident/services`);
  });

  it("uses the trusted deployment origin only inside a classified SMS-test turn", async () => {
    const captured = await runWithSmsTestTransport({
      actorUserId: "resident-a",
      managerUserId: "manager-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      appOrigin: "http://localhost:3010",
    }, () => getResidentLinksTool.handler(residentCtx("sms"), {}));

    expect(captured.result.links.application).toBe("http://localhost:3010/resident/applications");
    expect((await getResidentLinksTool.handler(residentCtx("sms"), {})).links.application)
      .toBe(`${PROD}/resident/applications`);
  });

  it("is available in the application phase and on every tier", () => {
    expect(residentAgentRegistry.has("get_resident_links")).toBe(true);
    expect(buildResidentRegistry(residentCtx("portal", "application")).has("get_resident_links")).toBe(true);
    const free = { ...residentCtx("portal"), managerTier: "free" } as ResidentAgentContext;
    expect(buildResidentRegistry(free).has("get_resident_links")).toBe(true);
  });
});

describe("get_vendor_links", () => {
  it("the portal tool keeps links in-app; the one-job SMS tool sends absolute links", async () => {
    const portal = await getVendorLinksTool.handler({} as VendorAgentContext, {});
    expect(portal.links.invoices).toBe("/vendor/financials/invoices");
    const sms = await getVendorSmsLinksTool.handler({} as AgentContext, {});
    expect(sms.links.invoices).toBe(`${PROD}/vendor/financials/invoices`);
    expect(sms.links.profile).toBe(`${PROD}/vendor/profile`);
  });

  it("is registered on the vendor portal and the vendor SMS registries, both read-only", () => {
    expect(vendorAgentRegistry.get("get_vendor_links")?.kind).toBe("read");
    expect(vendorWorkOrderAgentRegistry.get("get_vendor_links")?.kind).toBe("read");
    expect(vendorWorkOrderAgentRegistry.size).toBeLessThanOrEqual(6);
  });
});

describe("get_property_links (manager)", () => {
  const ctx = { landlordId: "mgr-1", userId: "mgr-1" } as AgentContext;

  it("mints listing, tour, apply, and message links for a live listing the manager may share", async () => {
    const res = await buildPropertyLinksForManager(ctx, {
      propertyId: "live-house",
      roomName: "Room B",
      listingRoomId: "room-b",
      prospectPhone: "+12065550100",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.title).toBe("Alder Row");
    expect(res.listingUrl).toBe(`${PROD}/rent/listings/live-house`);
    expect(res.tourUrl).toBe(`${PROD}/rent/tours-contact?propertyId=live-house`);
    expect(res.messageUrl).toBe(`${PROD}/rent/tours-contact?propertyId=live-house&tab=message`);
    expect(res.applyUrl).toContain(`${PROD}/rent/apply?`);
    expect(res.applyUrl).toContain("propertyId=live-house");
    expect(res.applyUrl).toContain("phone=%2B12065550100");
    expect(res.prefilled).toEqual({ listingRoomId: "room-b", roomName: "Room B", bundleId: null, phone: "+12065550100" });
  });

  it("refuses a listing the manager cannot share instead of minting a public link for it", async () => {
    const res = await buildPropertyLinksForManager(ctx, { propertyId: "someone-elses" });
    expect(res.ok).toBe(false);
  });

  it("is a manager read tool that also reaches the manager SMS surface", () => {
    expect(agentRegistry.get("get_property_links")?.kind).toBe("read");
    expect(getPropertyLinksTool.kind).toBe("read");
    expect(buildManagerSmsRegistry().has("get_property_links")).toBe(true);
    // Never on the prospect line: prospects get build_prospect_links, which is scoped to live public data.
    expect(leasingSmsAgentRegistry.has("get_property_links")).toBe(false);
  });
});

describe("keyword leasing bot", () => {
  it("a house question reply carries the listing link alongside tour and apply", () => {
    const reply = replyForIntent({
      intent: "question",
      origin: PROD,
      propertyId: "live-house",
      propertyLabel: "Alder Row",
    });
    expect(reply).toContain(`${PROD}/rent/listings/live-house`);
    expect(reply).toContain("/rent/tours-contact");
    expect(reply).toContain("/rent/apply");
  });
});

describe("link-first prompt contracts", () => {
  it("the leasing prospect agent sends the page for each request instead of handling it by text", () => {
    const p = LEASING_SMS_SYSTEM_PROMPT;
    expect(p).toMatch(/Links first/);
    // A question about the home ends with the listing link.
    expect(p).toMatch(/send the listingUrl so they can check out the full listing/);
    // Video and photos live on the listing page.
    expect(p).toMatch(/Photos, video, a virtual tour[\s\S]*Send the listingUrl/);
    // Apply and rental requirements go to the prefilled application.
    expect(p).toMatch(/what is needed or required to rent[\s\S]*send the applyUrl/);
    expect(p).toMatch(/Do not collect application details by text/);
    // Tours go to the tour page; texting a booking is the exception, not the default.
    expect(p).toMatch(/send the tourUrl and tell them to pick a time/);
    expect(p).toMatch(/text scheduling only when the prospect says they cannot use the link or explicitly asks to finish by text/);
    expect(p).toMatch(/offer two or three exact published choices/);
    expect(p).toMatch(/Only a later standalone affirmative/);
    // The old text-first booking instruction is gone.
    expect(p).not.toMatch(/book it by text rather than sending them away/);
    // An unanswerable house question still gets the links, never a bare "couldn't find it".
    expect(p).toMatch(/still send the listingUrl and the applyUrl rather than only saying you could not find it/);
  });

  it("resident, vendor, and manager surfaces all carry a links-first rule naming their link tool", () => {
    expect(AGENT_SYSTEM_PROMPTS.residentPortal).toMatch(/Links first[\s\S]*get_resident_links/);
    expect(AGENT_SYSTEM_PROMPTS.residentSms).toMatch(/Links first[\s\S]*get_resident_links/);
    expect(AGENT_SYSTEM_PROMPTS.residentInbox).toMatch(/Links first[\s\S]*get_resident_links/);
    expect(AGENT_SYSTEM_PROMPTS.vendorPortal).toMatch(/Links first[\s\S]*get_vendor_links/);
    expect(AGENT_SYSTEM_PROMPTS.vendorWorkOrderSms).toMatch(/Links first[\s\S]*get_vendor_links/);
    expect(AGENT_SYSTEM_PROMPTS.managerSms).toMatch(/Links first[\s\S]*get_property_links/);
    expect(MANAGER_PROMPT).toMatch(/Links first[\s\S]*get_property_links/);
    // Payments is the resident link the captain named explicitly.
    expect(AGENT_SYSTEM_PROMPTS.residentSms).toMatch(/pay or see charges/);
    for (const prompt of Object.values(AGENT_SYSTEM_PROMPTS)) {
      expect(prompt).not.toMatch(/localhost/);
    }
  });
});
