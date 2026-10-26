// @vitest-environment jsdom
//
// Settings > Profile > Phone "Verify": the button rides the saved phone's verification state, never the rollout
// switches (the shared-line flag below is read as OFF, and phone_required is a server-side switch the client never sees).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/ui/modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/modal")>()),
  useModalPresentation: () => "dialog",
}));
vi.mock("@/lib/shared-get-cache", () => ({
  sharedGet: vi.fn(async () => ({ ok: true, data: { enabled: false } })),
}));
// Panels the Settings layout only slots in; their internals are covered by their own suites.
vi.mock("@/components/portal/pro-plan", () => ({ ManagerPlan: () => <div /> }));
vi.mock("@/components/portal/portal-change-password-panel", () => ({ PortalChangePasswordPanel: () => <div /> }));
vi.mock("@/components/portal/portal-bug-feedback-panel", () => ({ PortalBugFeedbackPanel: () => <div /> }));
vi.mock("@/components/native/notifications-toggle", () => ({ NotificationsToggle: () => <div /> }));
vi.mock("@/components/portal/assistant-display-setting", () => ({ AssistantDisplaySetting: () => <div /> }));
vi.mock("@/components/portal/pro-api-keys-panel", () => ({ ManagerApiKeysPanel: () => <div /> }));
vi.mock("@/components/portal/pro-messaging-settings-panel", () => ({ ManagerMessagingSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/pro-portal-settings-panels", () => ({ CommunicationSettingsPanel: () => <div /> }));
vi.mock("@/components/portal/settings-module-page", () => ({ SettingsModulePage: () => <div /> }));
vi.mock("@/components/portal/manager-integrations-panel", () => ({
  INTEGRATIONS_TAB_PARAM: "integration",
  ManagerIntegrationsPanel: () => <div />,
}));
vi.mock("@/components/portal/google-calendar-connect-panel", () => ({ GoogleCalendarConnectPanel: () => <div /> }));
vi.mock("@/components/portal/manager-application-form-settings", () => ({ ManagerApplicationFormSettings: () => <div /> }));
vi.mock("@/components/portal/lease-document-library-panel", () => ({ LeaseDocumentLibraryPanel: () => <div /> }));

import { PortalProfileClient } from "@/components/portal/portal-profile-client";

const CHALLENGE = "11111111-1111-4111-8111-111111111111";

function renderProfile(props: { initialPhoneVerified?: boolean; initialPhone?: string } = {}) {
  return render(
    <PortalProfileClient
      variant="manager"
      portalKind="pro"
      initialFullName="Test Manager"
      initialEmail="manager@example.com"
      initialPhone={props.initialPhone ?? "+15103098345"}
      initialPhoneVerified={props.initialPhoneVerified}
      idValue="MGR-TEST"
      idLabel="PropLane ID"
    />,
  );
}

const phoneCalls = vi.fn();
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("profile phone Verify", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, "", "/portal/profile?tab=profile");
    phoneCalls.mockReset();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "https://proplane.test").pathname;
      if (path.startsWith("/api/auth/phone/")) return phoneCalls(path, init?.body ? JSON.parse(String(init.body)) : null);
      return json({ roles: ["manager"] });
    }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows Not verified and a Verify button for an unverified saved phone, with every switch off", () => {
    renderProfile({ initialPhoneVerified: false });
    expect(screen.getByText("+1 (510) 309-8345 · Not verified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });

  it("shows Verified and no Verify button once the phone is verified", () => {
    renderProfile({ initialPhoneVerified: true });
    expect(screen.getByText("+1 (510) 309-8345 · Verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });

  it("shows no status and no button when the state is unknown (demo) or there is no phone", () => {
    renderProfile({});
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    cleanup();
    renderProfile({ initialPhoneVerified: false, initialPhone: "" });
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });

  it("Verify texts a code (own-phone purpose, no phone in the body) and opens the code row", async () => {
    phoneCalls.mockResolvedValue(json({ challengeId: CHALLENGE }));
    renderProfile({ initialPhoneVerified: false });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Code sent to +1 (510) 309-8345")).toBeInTheDocument();
    expect(phoneCalls).toHaveBeenCalledWith("/api/auth/phone/start", { purpose: "verify_own_phone" });
    expect(screen.getByLabelText("6-digit code")).toHaveAttribute("maxlength", "6");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("a wrong code shows the server's message inline; the right one marks the phone Verified", async () => {
    phoneCalls.mockResolvedValueOnce(json({ challengeId: CHALLENGE }));
    renderProfile({ initialPhoneVerified: false });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.change(await screen.findByLabelText("6-digit code"), { target: { value: "123456" } });

    phoneCalls.mockResolvedValueOnce(json({ error: "That code didn't match. Try again." }, 400));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't match. Try again.");
    expect(screen.queryByText("+1 (510) 309-8345 · Verified")).not.toBeInTheDocument();

    phoneCalls.mockResolvedValueOnce(json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText("+1 (510) 309-8345 · Verified")).toBeInTheDocument());
    expect(phoneCalls).toHaveBeenLastCalledWith("/api/auth/phone/verify", {
      challengeId: CHALLENGE, code: "123456", purpose: "verify_own_phone",
    });
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("6-digit code")).not.toBeInTheDocument();
  });

  it("a number verified on another account is refused inline and stays unverified", async () => {
    phoneCalls.mockResolvedValue(json({ error: "This number is verified on another account." }, 400));
    renderProfile({ initialPhoneVerified: false });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This number is verified on another account.");
    expect(screen.getByText("+1 (510) 309-8345 · Not verified")).toBeInTheDocument();
    expect(screen.queryByLabelText("6-digit code")).not.toBeInTheDocument();
  });
});
