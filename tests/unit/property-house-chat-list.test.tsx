// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyHouseChatList } from "@/components/portal/property-house-chat-list";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const chat = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  maxPostsPerDay: 4,
  canManage: true,
  group: { members: [{ firstName: "Maya", roomLabel: "Room 1" }, { firstName: "Sam", roomLabel: "Room 2" }] },
  overflow: 0,
  waiting: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PropertyHouseChatList", () => {
  it("draws nothing at all while the line is per-workspace (the route answers 404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(404, { error: "Not available." }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PropertyHouseChatList propertyId="prop-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("lists members by first name and room only, with icon actions to announce and update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, chat())));
    const { container } = render(<PropertyHouseChatList propertyId="prop-1" />);
    expect(await screen.findByText("House chat")).toBeTruthy();
    expect(screen.getByText("2 residents")).toBeTruthy();
    expect(screen.getByText("Maya")).toBeTruthy();
    expect(screen.getByText("Room 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Announce" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update members" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d{3}[-. )]*\d{3}[-. ]*\d{4}/);
  });

  it("warns when more than nine residents live there and when some have not joined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, chat({ overflow: 2, waiting: 1 }))));
    render(<PropertyHouseChatList propertyId="prop-1" />);
    expect(await screen.findByText("2 more residents get texts one on one")).toBeTruthy();
    expect(screen.getByText("1 resident has not joined yet")).toBeTruthy();
  });

  it("shows Off with no member rows and no announce action while house chat is off", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, chat({ enabled: false, group: null }))));
    render(<PropertyHouseChatList propertyId="prop-1" />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Announce" })).toBeNull();
    expect(screen.queryByText("Maya")).toBeNull();
  });

  it("posts an announcement for this house through the route, with a request id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, chat()))
      .mockResolvedValueOnce(json(200, { ok: true, message: "Posted to 5259 Brooklyn." }));
    vi.stubGlobal("fetch", fetchMock);
    const toast = vi.fn();
    render(<PropertyHouseChatList propertyId="prop-1" showToast={toast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Announce" }));
    fireEvent.change(await screen.findByLabelText("Announcement"), { target: { value: "Water off Tuesday 9 to 12." } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Posted to 5259 Brooklyn."));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/portal/house-groups");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ action: "announce", propertyId: "prop-1", text: "Water off Tuesday 9 to 12." });
    expect(String(body.requestId).length).toBeGreaterThan(6);
  });
});
