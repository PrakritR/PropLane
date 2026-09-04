// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";

type Role = "manager" | "admin" | "resident" | "vendor";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("AssistantCustomInstructionsSetting", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ customInstructions: "Keep replies warm." });
      return jsonResponse({ customInstructions: "Keep replies warm." });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each<Role>(["manager", "admin", "resident", "vendor"])("loads the shared settings section for %s", async (role) => {
    render(<AssistantCustomInstructionsSetting role={role} />);

    expect(await screen.findByDisplayValue("Keep replies warm.")).toBeTruthy();
    expect(screen.getByText("PropLane Assistant")).toBeTruthy();
    expect(screen.getByLabelText("Custom instructions")).toHaveAttribute("data-attr", "assistant-custom-instructions-input");
    if (role === "manager") {
      expect(screen.getByText(/automated leasing text replies/i)).toBeTruthy();
    } else {
      expect(screen.queryByText(/automated leasing text replies/i)).toBeNull();
    }
  });

  it("saves server-backed instructions and reports completion", async () => {
    render(<AssistantCustomInstructionsSetting role="manager" />);
    const input = (await screen.findByLabelText("Custom instructions")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "End relevant resident drafts with Yo, thanks for rooming with me." } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({
      customInstructions: "End relevant resident drafts with Yo, thanks for rooming with me.",
    });
  });

  it("keeps the edit visible and reports a server save error", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse({ error: "Could not save custom instructions." }, 500)
        : jsonResponse({ customInstructions: "" }),
    );
    render(<AssistantCustomInstructionsSetting role="vendor" />);
    const input = (await screen.findByLabelText("Custom instructions")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Use plain language." } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save custom instructions.");
    expect(input.value).toBe("Use plain language.");
  });
});
