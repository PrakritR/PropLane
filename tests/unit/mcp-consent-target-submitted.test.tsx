// @vitest-environment jsdom
//
// The consent screen's "Connect as" choice has to reach the approve route. The picker renders in the rows ABOVE the
// Allow button, so it is outside the <form> element: per the HTML form-owner rule a form-associated control outside a
// form is submitted only when its `form` attribute names that form. The oracle is that rule, read through jsdom's own
// `new FormData(form)` — the same collection the browser posts. A picker with no form owner (the defect) yields a
// FormData with no `target` at all, and the approve route then falls back to the server-computed default, minting a
// manager connection for someone who asked for a resident one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  consent: {
    userId: "u1",
    email: "both@example.test",
    db: {} as never,
    options: [
      { value: "ws:w1", kind: "workspace" as const, workspaceId: "w1", label: "Main", service: false },
      { value: "resident", kind: "resident" as const, label: "As resident" },
    ],
    defaultValue: "ws:w1",
  } as Record<string, unknown> | null,
}));

vi.mock("@/lib/mcp/consent.server", () => ({
  loadMcpConsent: async () => h.consent,
  MCP_RESIDENT_TARGET: "resident",
}));
vi.mock("@/lib/mcp/oauth.server", () => ({
  MCP_OAUTH_SCOPE: "mcp:tools",
  getMcpOAuthClient: async () => ({ clientId: "c1", clientName: "Claude", redirectUris: ["https://claude.ai/cb"] }),
  signMcpApproval: () => "signed-approval",
}));

import McpAuthorizePage from "@/app/mcp/authorize/page";

const search = {
  client_id: "c1",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  response_type: "code",
  scope: "mcp:tools",
  state: "st",
};

async function renderPage() {
  render(await McpAuthorizePage({ searchParams: Promise.resolve(search) }));
  return document.querySelector("form[action='/api/mcp/oauth/approve']") as HTMLFormElement;
}

afterEach(() => {
  cleanup();
  h.consent = {
    userId: "u1",
    email: "both@example.test",
    db: {} as never,
    options: [
      { value: "ws:w1", kind: "workspace", workspaceId: "w1", label: "Main", service: false },
      { value: "resident", kind: "resident", label: "As resident" },
    ],
    defaultValue: "ws:w1",
  };
});

describe("the Connect as choice is part of the approve submission", () => {
  it("posts the picked target, not the server default", async () => {
    const form = await renderPage();
    const picker = screen.getByLabelText("Connect as") as HTMLSelectElement;
    expect(new FormData(form).get("target")).toBe("ws:w1");
    picker.value = "resident";
    const submitted = new FormData(form);
    expect(submitted.get("target")).toBe("resident");
    expect(submitted.get("approval")).toBe("signed-approval");
  });

  it("posts the only option when there is nothing to pick", async () => {
    h.consent = {
      userId: "u1",
      email: "resident@example.test",
      db: {} as never,
      options: [{ value: "resident", kind: "resident", label: "As resident" }],
      defaultValue: "resident",
    };
    const form = await renderPage();
    expect(screen.queryByLabelText("Connect as")).toBeNull();
    expect(new FormData(form).get("target")).toBe("resident");
  });

  it("an account with no connectable door is told so instead of being sent to sign in", async () => {
    h.consent = { userId: "u1", email: "nobody@example.test", db: {} as never, options: [], defaultValue: "" };
    render(await McpAuthorizePage({ searchParams: Promise.resolve(search) }));
    expect(screen.getByText("Nothing to connect yet")).toBeTruthy();
    expect(document.querySelector("form[action='/api/mcp/oauth/approve']")).toBeNull();
    expect(screen.getByText("Open PropLane")).toBeTruthy();
  });
});
