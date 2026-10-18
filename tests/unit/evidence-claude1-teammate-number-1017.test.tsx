// @vitest-environment jsdom
//
// Reviewer evidence for comanager-number-1015: a TEAMMATE (co-manager) of a
// workspace whose owner holds a work number reads that number as the
// workspace's own, never "Phone number not set up · Set up messaging" and
// never a false "Finishing setup".
//
// Every surface below is the REAL component the teammate sees, rendered with
// the status payload `/api/manager/messaging-number` now returns for them
// (`lineReady` = the LINE's readiness, `canSend` = this viewer's permission).
// With EVIDENCE_DIR set each one is dumped as screenshot-ready markup, painted
// by tests/browser/teammate-number-1017:
//
//   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-claude1-teammate-number-1017.test.tsx
//   EVIDENCE_DIR=<dir> npx playwright test --config tests/browser/teammate-number-1017.config.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { writeEvidenceSurface } from "../helpers/evidence-dom";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let mockPathname = "/portal/communication";
let mockSearch = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearch,
}));

const statusState = vi.fn();
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ active: { id: "ws-capitol-hill" } }),
}));

import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";
import { ManagerMessagingSetupBanner } from "@/components/portal/messaging-setup-banner";
import { ManagerSmsWorkNumberHint } from "@/components/portal/pro-sms-work-number-hint";

const OWNER_LINE = "+12065550199";

function status(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: null,
    canRequest: false,
    requestedAtSignup: false,
    lineReady: false,
    canSend: false,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

/** The teammate's payload: the line is the OWNER's, read off `workspaceNumber`. */
function teammate(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return status({
    workspaceRole: "co_manager",
    canRequest: false,
    number: null,
    workspaceNumber: { phoneNumber: OWNER_LINE, ownerUserId: "owner-1", ownerName: "Dana Reyes" },
    lineReady: true,
    canSend: true,
    ...overrides,
  });
}

function resolved(value: ManagerMessagingNumberStatus) {
  statusState.mockReturnValue({
    ready: true,
    resolved: true,
    statusError: false,
    status: value,
    retry: () => {},
  });
}

/** The work-email box is a second round trip; keep it realistic, not empty. */
function stubWorkEmail(address: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : String((input as Request).url);
      if (url.includes("/api/manager/assistant-email")) {
        return Response.json({
          provisioningAvailable: true,
          sendingAvailable: true,
          receivingAvailable: true,
          storageReady: true,
          planTier: "paid",
          entitlement: { eligible: true, tier: "pro", source: "stripe" },
          workspaceRole: "co_manager",
          workspaceEmail: address
            ? { address, ownerUserId: "owner-1", ownerName: "Dana Reyes" }
            : null,
          address,
          state: address ? "ready" : "unavailable",
          canRequest: false,
          canUse: Boolean(address),
          requestedAtSignup: false,
        });
      }
      return new Response(null, { status: 404 });
    }),
  );
}

const card = () => document.querySelector('[data-attr="manager-work-number-card"]');

afterEach(() => {
  cleanup();
  statusState.mockReset();
  vi.unstubAllGlobals();
  mockPathname = "/portal/communication";
  mockSearch = new URLSearchParams();
});

describe("the work-number box a teammate reads in Communication", () => {
  it("shows the workspace's live line with no readiness nag", async () => {
    stubWorkEmail("capitolhill@proplane.app");
    // A read-only teammate (`canSend: false`) is still looking at a perfectly
    // set-up line: the caption reads `lineReady`, never their own permission.
    resolved(teammate({ canSend: false }));
    render(<ManagerWorkNumberCard />);

    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.getByText("Workspace number")).toBeTruthy();
    expect(screen.getByText("+1 (206) 555-0199")).toBeTruthy();
    expect(screen.queryByText("Finishing setup")).toBeNull();
    expect(screen.queryByText("No work number yet")).toBeNull();
    expect(screen.queryByText("Set up work number")).toBeNull();
    expect(document.body.textContent).not.toContain("Phone number not set up");

    writeEvidenceSurface(
      "01-teammate-work-number-live",
      "Teammate (co-manager) in Dana Reyes' workspace, Communication header — the workspace's work number, no setup nag, no \"Finishing setup\". Read-only teammate (canSend: false, lineReady: true).",
    );
  });

  it("still says Finishing setup when the owner's line genuinely is not ready", async () => {
    stubWorkEmail("capitolhill@proplane.app");
    resolved(teammate({ lineReady: false, canSend: false }));
    render(<ManagerWorkNumberCard />);

    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.getByText("+1 (206) 555-0199")).toBeTruthy();
    expect(screen.getByText("Finishing setup")).toBeTruthy();

    writeEvidenceSurface(
      "02-teammate-work-number-not-ready",
      "Same teammate when the line itself cannot send (lineReady: false) — the honest \"Finishing setup\" caption is still shown, so the fix is not a blanket suppression.",
    );
  });

  it("asks the owner, by name, when the workspace has no number at all", async () => {
    stubWorkEmail(null);
    resolved(
      teammate({
        workspaceNumber: { phoneNumber: null, ownerUserId: "owner-1", ownerName: "Dana Reyes" },
        lineReady: false,
        canSend: false,
      }),
    );
    render(<ManagerWorkNumberCard />);

    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.getByText("No work number yet")).toBeTruthy();
    // The email box carries the same "ask the owner" note, so scope to the number box.
    expect(card()?.textContent).toContain("Ask Dana Reyes to set one up in Settings → Messaging");
    // Never the owner-only CTA: a teammate cannot provision a line.
    expect(screen.queryByText("Set up work number")).toBeNull();

    writeEvidenceSurface(
      "03-teammate-work-number-none",
      "Teammate in a workspace whose owner never set a number up — \"No work number yet · Ask Dana Reyes to set one up\", never a setup button the teammate cannot use.",
    );
  });

  it("shows the owner their own line the same way", async () => {
    stubWorkEmail("dana@proplane.app");
    resolved(
      status({
        number: {
          state: "active",
          registrationState: "approved",
          carrierRegistrationState: "registered",
          attachmentState: "attached",
          phoneNumber: OWNER_LINE,
          lastError: null,
        },
        lineReady: true,
        canSend: true,
      }),
    );
    render(<ManagerWorkNumberCard />);

    await waitFor(() => expect(card()).not.toBeNull());
    expect(screen.getByText("Work number")).toBeTruthy();
    expect(screen.queryByText("Finishing setup")).toBeNull();

    writeEvidenceSurface(
      "04-owner-work-number-live",
      "The owner of the same workspace, for comparison — \"Work number\", identical readiness.",
    );
  });
});

describe("the portal-wide setup nag", () => {
  it("never reaches a teammate", () => {
    resolved(teammate({ workspaceNumber: { phoneNumber: null, ownerUserId: "owner-1", ownerName: "Dana Reyes" } }));
    const { container } = render(
      <div>
        <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a" }}>
          Communication, signed in as the teammate — the slot the banner would occupy:
        </p>
        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, minHeight: 44, display: "grid", placeItems: "center", color: "#64748b", font: "500 12px/1.4 system-ui" }}>
          <ManagerMessagingSetupBanner />
          (nothing — the nag is owner-only)
        </div>
      </div>,
    );

    expect(container.querySelector('[data-attr="manager-messaging-setup-banner"]')).toBeNull();
    expect(container.textContent).not.toContain("Phone number not set up");

    writeEvidenceSurface(
      "05-setup-nag-teammate",
      "Owner-only nag: the teammate's Communication page renders no \"Phone number not set up · Set up messaging\" band at all.",
    );
  });

  it("still reaches the owner who has no number", () => {
    resolved(status({ number: null, planTier: "paid" }));
    render(
      <div>
        <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a" }}>
          Communication, signed in as the workspace OWNER with no number yet:
        </p>
        <ManagerMessagingSetupBanner />
      </div>,
    );

    const banner = document.querySelector('[data-attr="manager-messaging-setup-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Phone number not set up");
    expect(banner?.textContent).toContain("Set up messaging");

    writeEvidenceSurface(
      "06-setup-nag-owner",
      "The same band is untouched for the owner, who is the one person who can act on it.",
    );
  });
});

describe("the compose-surface SMS hint", () => {
  it("is silent on a live line and blames the carrier only when the carrier is at fault", () => {
    render(
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a", margin: "0 0 4px" }}>
            Live workspace line, teammate composing (lineReady: true):
          </p>
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, minHeight: 32, padding: 8, color: "#64748b", font: "500 12px/1.4 system-ui" }}>
            <ManagerSmsWorkNumberHint show phone={OWNER_LINE} lineReady />
            (no warning — the line works)
          </div>
        </div>
        <div>
          <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a", margin: "0 0 4px" }}>
            Line pending carrier registration:
          </p>
          <ManagerSmsWorkNumberHint show phone={OWNER_LINE} lineReady={false} awaitingCarrier />
        </div>
        <div>
          <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a", margin: "0 0 4px" }}>
            Registered line that cannot send right now (wallet / send switch) — the carrier is not blamed:
          </p>
          <ManagerSmsWorkNumberHint show phone={OWNER_LINE} lineReady={false} />
        </div>
        <div>
          <p style={{ font: "600 12px/1.4 system-ui", color: "#0f172a", margin: "0 0 4px" }}>
            No work number at all:
          </p>
          <ManagerSmsWorkNumberHint show phone={null} lineReady={false} />
        </div>
      </div>,
    );

    const alerts = screen.getAllByRole("alert").map((el) => el.textContent ?? "");
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toContain("SMS is waiting on carrier approval for +1 (206) 555-0199.");
    expect(alerts[1]).toContain("SMS cannot send from +1 (206) 555-0199 right now.");
    expect(alerts[1]).not.toContain("carrier");
    expect(alerts[2]).toContain("SMS needs an active work number.");

    writeEvidenceSurface(
      "07-compose-sms-hint-states",
      "The compose hint now keys off the LINE: silent when it can send, the carrier sentence only while the carrier is reviewing, and no \"Finish setup\" for a live line.",
    );
  });
});
