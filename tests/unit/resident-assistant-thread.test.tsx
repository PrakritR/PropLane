// @vitest-environment jsdom
//
// The pinned PropLane row's thread pane is the SAME assistant as the top bar: it mounts the shared dock panel on the
// one resident endpoint (no second route, no send-inbox-message path).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const panelProps = vi.fn();
vi.mock("@/components/portal/assistant-dock-panel", () => ({
  AssistantDockPanel: (props: Record<string, unknown>) => {
    panelProps(props);
    return <div data-testid="dock-panel" />;
  },
}));
vi.mock("@/lib/axis-assistant/portal-assistant-context", () => ({
  usePortalAssistantConfig: () => ({ endpoint: "/api/agent/resident-chat", managerName: "Mia Resident" }),
}));

import { ResidentAssistantThread } from "@/components/portal/resident-assistant-thread";

afterEach(() => {
  cleanup();
  panelProps.mockClear();
});

describe("ResidentAssistantThread", () => {
  it("mounts the shared dock panel on the resident endpoint with the resident's name", () => {
    const onClose = vi.fn();
    render(<ResidentAssistantThread onClose={onClose} />);
    const props = panelProps.mock.calls[0]![0] as Record<string, unknown>;
    expect(props.endpoint).toBe("/api/agent/resident-chat");
    expect(props.managerName).toBe("Mia Resident");
    expect(props.onClose).toBe(onClose);
    // The portal's "Ask PropLane" focus hook belongs to the side panel, so two inputs never share it.
    expect(props.inputId).toBeUndefined();
  });
});
