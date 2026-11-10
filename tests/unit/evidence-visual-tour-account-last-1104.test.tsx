// @vitest-environment jsdom
/**
 * Evidence harness (visual) — a tour now asks for the account LAST.
 *
 * Renders the real public tour flow (`TourScheduleFlow`, the component
 * `/rent/tours-contact` mounts) in the three states that matter and writes each one to
 * EVIDENCE_DIR as a page in the app's own stylesheet, for screenshotting:
 *
 *   1. signed out, step 1 — the days and times are open to a stranger, no gate in front of them
 *   2. signed out, step 2 — "Your details" IS the account step, and the picked slot rides the
 *      sign-in `next` as `/resident/tour/schedule?propertyId=…&slot=…&room=…`
 *   3. back from signup — the same pick is preselected and the account's contact is prefilled
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockProperty } from "@/data/types";
import { writeEvidencePage } from "../helpers/evidence-page";

const session = vi.hoisted(() => ({
  state: { ready: true, userId: "u1" as string | null, hasResidentRole: true, name: "Prakrit Ramachandran", email: "prakrit@example.com", phone: "2065550123" },
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({ useProspectContactAutofill: () => session.state }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/tour-resident-link.client", () => ({ linkBookedToursToSignedInResident: async () => true }));

import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.state.userId = "u1";
});

const PROPERTY: MockProperty = {
  id: "prop-ballard",
  title: "2412 Clifford St",
  tagline: "",
  address: "2412 Clifford St",
  zip: "98107",
  neighborhood: "Ballard",
  beds: 3,
  baths: 2,
  rentLabel: "$1,200/mo",
  available: "Now",
  petFriendly: true,
  buildingId: "b1",
  buildingName: "Clifford House",
  unitLabel: "Room A",
};

const HOST = [{ userId: "mgr-1", label: "Manager", propertyId: "prop-ballard" }];
/** Three open times on one day, plus one on the next, so the calendar and the time row both have something to show. */
const SLOTS = { "2099-08-06:20": HOST, "2099-08-06:22": HOST, "2099-08-06:24": HOST, "2099-08-07:20": HOST };

function stubFetch(slotHosts: Record<string, unknown[]>) {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/public/partner-inquiries")) {
        posts.push(JSON.parse(String(init?.body)).row);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ slotHosts }) } as unknown as Response;
    }),
  );
  return posts;
}

/** The public tour page's own wrapper, so the screenshot is styled like `/rent/tours-contact`. */
function pageHtml(container: HTMLElement): string {
  return `<div class="ps ps-j-page"><div class="ps-j-col"><div class="ps-j-title"><h1 class="ps-h1">Book a tour</h1></div><div class="ps-j-stack">${container.innerHTML}</div></div></div>`;
}

describe("a signed-out visitor picks the time first and is asked for an account at Your details", () => {
  it("step 1 shows the days and times with no account gate in front of them", async () => {
    session.state.userId = null;
    const posts = stubFetch(SLOTS);
    const view = render(<TourScheduleFlow property={PROPERTY} returnAfterAuth="/resident/tour" onSuccess={() => {}} />);

    const days = await screen.findAllByRole("button", { name: /open for tours$/ });
    expect(days.length).toBeGreaterThan(0);
    fireEvent.click(days[0]!);
    await screen.findByRole("button", { name: /10 am/i });

    writeEvidencePage("tour-1-signed-out-date-and-time", pageHtml(view.container), {
      title: "/rent/tours-contact — signed out, step 1 of 2: the days and times are open to a stranger (no sign-in gate)",
      width: 900,
    });

    // Nothing is asked of the visitor yet and nothing is written.
    expect(screen.queryByText("Sign in to request a tour time")).toBeNull();
    expect(document.querySelector('[data-attr="tour-account-step"]')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("step 2 is the account step, and the pick rides the sign-in next", async () => {
    session.state.userId = null;
    const posts = stubFetch(SLOTS);
    const view = render(<TourScheduleFlow property={PROPERTY} returnAfterAuth="/resident/tour" onSuccess={() => {}} />);

    fireEvent.click((await screen.findAllByRole("button", { name: /open for tours$/ }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /10 am/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(document.querySelector('[data-attr="tour-account-step"]')).toBeTruthy());
    writeEvidencePage("tour-2-signed-out-account-step", pageHtml(view.container), {
      title: '/rent/tours-contact — signed out, step 2 "Your details": the account is asked for here, with the pick already made',
      width: 900,
    });

    const email = document.querySelector('[data-attr="tour-account-email"]') as HTMLAnchorElement;
    const next = new URL(new URL(email.getAttribute("href")!, "http://x").searchParams.get("next")!, "http://x");
    expect(next.pathname).toBe("/resident/tour/schedule");
    expect(next.searchParams.get("propertyId")).toBe("prop-ballard");
    expect(next.searchParams.get("slot")).toBe("2099-08-06:20");
    expect(next.searchParams.get("room")).toBe("any");
    // No contact form, no booking button, nothing filed before the account exists.
    expect(document.querySelector('[data-attr="tour-book-submit"]')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("the pick survives the account step: it comes back preselected with the contact prefilled", async () => {
    stubFetch(SLOTS);
    const view = render(
      <TourScheduleFlow
        property={PROPERTY}
        returnAfterAuth="/resident/tour"
        onSuccess={() => {}}
        embedded
        initialSlotKey="2099-08-06:20"
        initialRoom="any"
      />,
    );

    expect(await screen.findByRole("button", { name: /Book tour|Request tour/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-attr="tour-slot-taken"]')).toBeNull());
    writeEvidencePage("tour-3-back-from-signup-preselected", view.container.innerHTML, {
      title: "/resident/tour/schedule?slot=2099-08-06:20&room=any — back from the account step: the same time is preselected and the account's contact is prefilled",
      width: 760,
    });

    expect((document.getElementById("tour-email") as HTMLInputElement).value).toBe("prakrit@example.com");
    expect((document.getElementById("tour-name") as HTMLInputElement).value).toBe("Prakrit Ramachandran");
  });

  it("a time taken while the person was signing up is said inline, with the next open times", async () => {
    stubFetch({ "2099-08-06:22": HOST, "2099-08-07:20": HOST });
    const view = render(
      <TourScheduleFlow property={PROPERTY} returnAfterAuth="/resident/tour" onSuccess={() => {}} embedded initialSlotKey="2099-08-06:20" />,
    );

    const taken = await waitFor(() => {
      const el = document.querySelector('[data-attr="tour-slot-taken"]');
      expect(el).toBeTruthy();
      return el!;
    });
    writeEvidencePage("tour-4-slot-taken-while-signing-up", view.container.innerHTML, {
      title: "the picked time was taken while the person created their account: said inline, with the next open times to tap",
      width: 760,
    });

    expect(taken.textContent).toContain("That time was just taken.");
    expect(document.querySelectorAll('[data-attr="tour-next-open-time"]')).toHaveLength(2);
  });
});
