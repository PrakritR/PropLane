// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import {
  approvedResidentsForWorkNumberAnnounce,
  formatWorkNumberAnnounceRecipientDisplay,
} from "@/components/portal/pro-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

/**
 * The panel now also mounts the pay-as-you-go billing card, which fetches
 * /api/manager/comms-billing on mount. A plain `mockResolvedValueOnce` queue
 * gets consumed by that call, so every positional assertion below shifted.
 * Route by URL instead: billing answers "disabled" (the card renders nothing),
 * and the queued responses stay reserved for the work-number endpoint.
 */
function messagingFetchMock(responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes("/api/manager/comms-billing")) {
      return Response.json({ paygEnabled: false });
    }
    return queue.shift() ?? Response.json({});
  });
  return fn;
}

/** Only the work-number calls — billing noise excluded. */
function numberCalls(fn: ReturnType<typeof messagingFetchMock>) {
  return fn.mock.calls.filter((c) => !String(c[0]).includes("/api/manager/comms-billing"));
}

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-test", email: "mgr@example.com", ready: true }),
}));

vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: vi.fn(() => [
    {
      id: "res-1",
      name: "Alex Resident",
      email: "alex@example.com",
      role: "resident",
      tenancyStatus: "resident",
    },
    {
      id: "res-2",
      name: "Jordan Resident",
      email: "jordan@example.com",
      role: "resident",
      tenancyStatus: "resident",
    },
    {
      id: "app-1",
      name: "Pending Applicant",
      email: "pending@example.com",
      role: "resident",
      tenancyStatus: "applicant",
    },
  ]),
}));

const pausedStatus: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
  sendingAvailable: false,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: null,
  canRequest: false,
  canSend: false,
  personalPhone: {
    phone: "+15105550123",
    verifiedAt: "2026-08-25T12:00:00.000Z",
    forwardInbound: true,
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("work number resident announce recipients", () => {
  it("lists only approved residents for the broadcast", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    expect(residents.map((r) => r.email)).toEqual(["alex@example.com", "jordan@example.com"]);
  });

  it("formats resident emails for the To field", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    expect(formatWorkNumberAnnounceRecipientDisplay(residents)).toBe(
      "alex@example.com, jordan@example.com",
    );
  });

  it("ignores malformed legacy recipient emails instead of crashing", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    Object.assign(residents[0]!, { email: { legacy: "alex@example.com" } });
    expect(() => formatWorkNumberAnnounceRecipientDisplay(residents)).not.toThrow();
    expect(formatWorkNumberAnnounceRecipientDisplay(residents)).toBe("jordan@example.com");
  });
});

describe("ManagerMessagingSettingsPanel", () => {
  it.each(["free", "trialing"] as const)("recovers a numberless %s snapshot after a paid upgrade", async (reason) => {
    const stale: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      entitlement: { eligible: false, reason },
    };
    const refreshed: ManagerMessagingNumberStatus = {
      ...stale,
      entitlement: { eligible: true, tier: "business", source: "stripe" },
      canRequest: true,
    };
    showToast.mockClear();
    let finishRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const assigned: ManagerMessagingNumberStatus = {
      ...refreshed,
      canRequest: false,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+15105550199",
        lastError: null,
      },
    };
    const fetchMock = messagingFetchMock([Response.json(stale), pendingRefresh, Response.json(assigned)]);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ManagerMessagingSettingsPanel />);
    const stages: string[] = [];
    const capture = (label: string) => stages.push(`<section><h2>${label}</h2>${container.innerHTML}</section>`);

    const refresh = await screen.findByRole("button", { name: "Refresh eligibility" });
    capture("1. Settled stale eligibility");
    fireEvent.click(refresh);
    const checking = await screen.findByRole("button", { name: "Checking…" });
    expect(checking.getAttribute("aria-busy")).toBe("true");
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    capture("2. Checking eligibility");
    expect(showToast).not.toHaveBeenCalled();
    finishRefresh(Response.json(refreshed));
    expect(await screen.findByRole("button", { name: "Request work number" })).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith("Messaging eligibility refreshed.");
    expect(numberCalls(fetchMock)).toHaveLength(2);
    expect(JSON.parse(String(numberCalls(fetchMock)[1]?.[1]?.body)).action).toBe("refresh_eligibility");
    capture("3. Recovered eligibility permits setup");
    fireEvent.click(screen.getByRole("button", { name: "Request work number" }));
    expect(await screen.findByText("+1 (510) 555-0199")).toBeTruthy();
    expect(numberCalls(fetchMock)).toHaveLength(3);
    expect(JSON.parse(String(numberCalls(fetchMock)[2]?.[1]?.body))).toEqual({ action: "request_number", areaCode: "510" });
    expect(screen.queryByRole("button", { name: "Request work number" })).toBeNull();
    capture("4. Assigned work number; texting runtime remains off");
    if (process.env.WORK_NUMBER_EVIDENCE_DIR) {
      mkdirSync(process.env.WORK_NUMBER_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.WORK_NUMBER_EVIDENCE_DIR, `recovery-${reason}.html`),
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Work-number recovery: ${reason}</title><link rel="stylesheet" href="product.css"><style>body{padding:24px;font-family:Arial,sans-serif}main{max-width:800px;margin:auto}section{margin:32px 0;padding:20px;border:1px solid #ddd}h2{margin-bottom:20px;font-size:20px}</style><body><main><h1>Work-number recovery: ${reason}</h1><p>Actual component rendered during interaction tests. Billing and provisioning responses are fixtures; this is not a live provider transaction.</p>${stages.join("")}</main></body></html>`);
    }
  });

  it("shows a recoverable error for a malformed API payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ personalPhone: [] })));
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText("Couldn't load messaging settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a paused rollout without offering a provisioning action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(pausedStatus)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByText(
        "Dedicated number setup is in a limited rollout.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Request work number" }),
    ).toBeNull();
    expect(screen.queryByText("+1 (510) 555-0123 · Verified")).toBeNull();
  });

  it("requests a number only from the explicit setup button", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      canRequest: true,
    };
    const requested: ManagerMessagingNumberStatus = {
      ...readyToRequest,
      number: {
        state: "pending_registration",
        registrationState: "pending",
        carrierRegistrationState: "not_submitted",
        attachmentState: "not_attached",
        phoneNumber: null,
        lastError: null,
      },
      canRequest: false,
    };
    const fetchMock = messagingFetchMock([Response.json(readyToRequest), Response.json(requested)]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    const request = await screen.findByRole("button", {
      name: "Request work number",
    });
    expect((screen.getByLabelText("Preferred area code (optional)") as HTMLInputElement).value).toBe("510");
    fireEvent.click(request);

    await waitFor(() => expect(numberCalls(fetchMock)).toHaveLength(2));
    expect(numberCalls(fetchMock)[0]?.[1]).not.toMatchObject({ method: "POST" });
    expect(numberCalls(fetchMock)[1]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(numberCalls(fetchMock)[1]?.[1]?.body))).toEqual({
      action: "request_number",
      areaCode: "510",
    });
    expect(await screen.findByText("Request received")).toBeTruthy();
  });

  it("lets co-managers request their own work number like any manager account", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      workspaceRole: "co_manager",
      provisioningAvailable: true,
      canRequest: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(readyToRequest)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: "Request work number" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/your dedicated PropLane number/i),
    ).toBeTruthy();
    expect(
      screen.queryByText("The primary property manager manages messaging."),
    ).toBeNull();
  });

  it("opens a resident-announce dialog after a number is assigned", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      sendingAvailable: false,
      canRequest: true,
    };
    const assigned: ManagerMessagingNumberStatus = {
      ...readyToRequest,
      canRequest: false,
      // The broadcast is only offered for a number that can actually send —
      // an unusable one may not even belong to this Twilio account.
      canSend: true,
      sendingAvailable: true,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+15105550199",
        lastError: null,
      },
    };
    const fetchMock = messagingFetchMock([Response.json(readyToRequest), Response.json(assigned)]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Request work number" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Want to send a message to all your residents to text this new number now?"),
    ).toBeTruthy();
    expect(within(dialog).getByText("To")).toBeTruthy();
    expect(
      within(dialog).getByText("alex@example.com, jordan@example.com"),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Subject")).toBeTruthy();
    expect(within(dialog).getByLabelText("Message")).toBeTruthy();
    expect(within(dialog).getByLabelText("Send via")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Notify all residents" })).toBeTruthy();
  });

  it("toasts on announce failure so it shows above the open modal", async () => {
    showToast.mockClear();
    const usable: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      canSend: true,
      sendingAvailable: true,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+18559168031",
        lastError: null,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal/send-inbox-message")) {
        return Response.json({ ok: false, error: "Delivery failed." }, { status: 500 });
      }
      if (url.includes("/api/portal/automation-settings")) {
        return Response.json({ settings: {} });
      }
      return Response.json(usable);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Tell residents about this number",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Notify all residents" }),
    );

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Delivery failed."),
    );
    // Failure keeps the modal open so the manager can retry.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not blame the carrier when texting is off for the deployment", async () => {
    // Registered + active + eligible, yet unsendable purely because this
    // deployment's texting runtime is off. Calling that "Approval in progress"
    // sends the manager to chase an approval Twilio already granted.
    const registeredButOff: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      sendingAvailable: false,
      canSend: false,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+15645652487",
        lastError: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(registeredButOff)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText("Texting turned off")).toBeTruthy();
    expect(screen.queryByText("Approval in progress")).toBeNull();
    expect(
      screen.getByText(/texting is switched\s+off for this workspace/i),
    ).toBeTruthy();
  });

  it("still reports carrier approval while the number is genuinely pending", async () => {
    const stillPending: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      sendingAvailable: true,
      canSend: false,
      number: {
        state: "active",
        registrationState: "pending",
        carrierRegistrationState: "pending",
        attachmentState: "attached",
        phoneNumber: "+15645652487",
        lastError: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(stillPending)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText("Approval in progress")).toBeTruthy();
    expect(screen.queryByText("Texting turned off")).toBeNull();
  });

  it("never offers a resident broadcast for a number that cannot send", async () => {
    // A record can name a number this Twilio account does not own — that
    // shipped. Broadcasting it would point every resident at a stranger.
    const assignedButUnusable: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      canSend: false,
      sendingAvailable: false,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+15645652487",
        lastError: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(assignedButUnusable)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText("+1 (564) 565-2487")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Tell residents about this number" }),
    ).toBeNull();
  });

  it("offers the resident broadcast once the number can actually send", async () => {
    const usable: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      canSend: true,
      sendingAvailable: true,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+18559168031",
        lastError: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(usable)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByRole("button", {
        name: "Tell residents about this number",
      }),
    ).toBeTruthy();
  });

  it("never asks billing again for an assigned number whose plan already has a settled answer", async () => {
    // `past_due` is a real answer, not an unread one, so there is nothing for
    // the panel to settle: restoring billing arrives through the Stripe and
    // RevenueCat webhooks. Re-reading it on every visit would be a billing call
    // per page view that changes nothing.
    const ineligible: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      entitlement: { eligible: false, reason: "past_due" },
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550123",
        lastError: null,
      },
    };
    const fetchMock = messagingFetchMock([Response.json(ineligible), Response.json(ineligible)]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    await screen.findByText("+1 (206) 555-0123");
    await Promise.resolve();
    expect(numberCalls(fetchMock)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Check eligibility" })).toBeNull();
  });

  it("settles a brand-new account's unconfirmed plan without asking the manager to press anything", async () => {
    // A manager who has never been reconciled has no stored entitlement row,
    // which reads back as `plan_unreadable`. Reading the billing source needs
    // no human judgement, so the panel settles it on sight rather than parking
    // the one account that cannot interpret the state behind a button.
    const unchecked: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      planTier: "unknown",
      entitlement: { eligible: false, reason: "plan_unreadable" },
      number: null,
    };
    const fetchMock = messagingFetchMock([Response.json(unchecked), Response.json({
          ...unchecked,
          // Once reconciled, the plan class settles — here to a confirmed free
          // plan, which is what the upsell copy keys off under plan-tier gating.
          planTier: "free",
          entitlement: { eligible: false, reason: "free" },
        }),]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    await waitFor(() => expect(numberCalls(fetchMock)).toHaveLength(2));
    expect(JSON.parse(String(numberCalls(fetchMock)[1]?.[1]?.body))).toEqual({
      action: "refresh_eligibility",
    });
    expect(screen.queryByRole("button", { name: "Check eligibility" })).toBeNull();
    // Once settled, the state is a real plan answer with a real next step.
    expect(
      await screen.findByText(
        // PAYG changed this line: a number is no longer "included" with a paid
        // plan, so the free-plan next step is upgrade AND a payment method.
        "Upgrade to Pro or Business, then add a payment method for pay-as-you-go texting and voice.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "View plans" })).toBeTruthy();
  });

  it("gives free-plan managers a direct path to billing", async () => {
    const freePlan: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      planTier: "free",
      entitlement: { eligible: false, reason: "free" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(freePlan)),
    );
    render(<ManagerMessagingSettingsPanel />);

    const link = await screen.findByRole("link", { name: "View plans" });
    expect(link.getAttribute("href")).toBe("/portal/profile?tab=billing");
  });

  it("never shows a paid manager the free-tier upsell while entitlement is unreconciled", async () => {
    // The reported bug: a Business account whose sms_manager_entitlements row
    // has not been written yet resolves to `plan_unreadable`. The upsell must
    // NOT appear — the panel falls through to the request/rollout flow.
    const paidUnreconciled: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      planTier: "paid",
      entitlement: { eligible: false, reason: "plan_unreadable" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(paidUnreconciled)),
    );
    render(<ManagerMessagingSettingsPanel />);

    // Rollout copy proves the panel resolved to the non-upsell branch.
    await screen.findByText("Dedicated number setup is in a limited rollout.", {
      exact: false,
    });
    expect(screen.queryByRole("link", { name: "View plans" })).toBeNull();
    expect(
      screen.queryByText("We could not verify your messaging eligibility.", {
        exact: false,
      }),
    ).toBeNull();
  });

  it("shows a retryable provisioning failure and its provider diagnostic without claiming A2P review", async () => {
    const failed: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      canRequest: true,
      number: {
        state: "failed",
        registrationState: "approved",
        carrierRegistrationState: "not_submitted",
        attachmentState: "failed",
        phoneNumber: null,
        lastError:
          "Twilio Messaging Service sender-pool attachment failed (code 20403, HTTP 403). The purchased number was released.",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(failed)));

    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByText("Setup failed before a work number became active.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/code 20403, HTTP 403/)).toBeTruthy();
    expect(screen.queryByText(/requires PropLane review/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
  });

  it("does not render an unexpected internal last_error as a public diagnostic", async () => {
    const failed: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      number: {
        state: "failed",
        registrationState: "approved",
        carrierRegistrationState: "not_submitted",
        attachmentState: "failed",
        phoneNumber: null,
        lastError: "database host and provider account details",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(failed)));

    render(<ManagerMessagingSettingsPanel />);

    await screen.findByText("Setup failed before a work number became active.", {
      exact: false,
    });
    expect(screen.queryByText(/database host/i)).toBeNull();
  });

  it("applies the fresh failed status returned by a failed setup request", async () => {
    const ready: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      canRequest: true,
    };
    const failed: ManagerMessagingNumberStatus = {
      ...ready,
      number: {
        state: "failed",
        registrationState: "approved",
        carrierRegistrationState: "not_submitted",
        attachmentState: "failed",
        phoneNumber: null,
        lastError:
          "Twilio Messaging Service sender-pool attachment failed (code 20403, HTTP 403). The purchased number was released.",
      },
    };
    const fetchMock = messagingFetchMock([Response.json(ready), Response.json(
          { ...failed, error: failed.number?.lastError },
          { status: 502 },
        ),]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Request work number" }),
    );

    expect(
      await screen.findByText("Setup failed before a work number became active.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
    expect(
      document.querySelector(
        '[data-attr="messaging-number-failure-diagnostic"]',
      )?.textContent,
    ).toContain("code 20403, HTTP 403");
  });

  it("applies a quarantined provision status so Retry disappears", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      canRequest: true,
    };
    const quarantined: ManagerMessagingNumberStatus & { error: string } = {
      ...readyToRequest,
      canRequest: false,
      number: {
        state: "provisioning",
        registrationState: "pending",
        carrierRegistrationState: "not_submitted",
        attachmentState: "not_attached",
        phoneNumber: null,
        lastError:
          "Twilio release was not confirmed after a failed attach. PropLane will not retry automatically.",
        setupNeedsAttention: true,
      },
      error:
        "Twilio release was not confirmed after a failed attach. PropLane will not retry automatically.",
    };
    const fetchMock = messagingFetchMock([Response.json(readyToRequest), Response.json(quarantined, { status: 502 })]);
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Request work number" }));

    expect(
      await screen.findByText(/will not retry automatically/i),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Request work number" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
    });
  });
});
