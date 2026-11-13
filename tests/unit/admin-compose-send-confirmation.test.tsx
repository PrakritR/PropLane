// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const append = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const dialog = vi.hoisted(() => ({ submit: () => {} }));
vi.mock("@/lib/demo-admin-partner-inbox", () => ({ appendInboxMessage: append }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: toast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/components/portal/portal-dialog", () => ({ PortalDialog: ({ children, primaryAction }: { children: ReactNode; primaryAction: { onClick: () => void; disabled: boolean; label: string } }) => { dialog.submit = primaryAction.onClick; return <div>{children}<button disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</button></div>; } }));
vi.mock("@/components/portal/popup-live-preview", () => ({ PopupMessagePreview: () => null, PopupRecordPreview: () => null }));
import { AdminComposeModal } from "@/components/portal/admin-compose-modal";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openCompose() {
  const onClose = vi.fn(), onSent = vi.fn();
  render(<AdminComposeModal open onClose={onClose} onSent={onSent} recipients={{ managers: [{ id: "m1", name: "Manager", email: "m@example.invalid" }], residents: [] }} />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Manager" })).toBeChecked());
  fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Subject" } });
  fireEvent.change(screen.getByPlaceholderText("Write your message…"), { target: { value: "Message" } });
  return { onClose, onSent };
}

it("waits for a confirmed send before appending exactly once", async () => {
  let resolve!: (value: unknown) => void;
  const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetchMock);
  const { onClose, onSent } = await openCompose();
  act(() => { dialog.submit(); dialog.submit(); });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(append).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  resolve({ ok: true, json: async () => ({ ok: true }) });
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSent).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledOnce();
});

it.each([403, 500, 200])("keeps the draft and reports a failed send for HTTP %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status === 200, json: async () => ({ ok: false }) })));
  const { onClose } = await openCompose();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Message could not be sent. Please try again."));
  expect(onClose).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText("Subject")).toHaveValue("Subject");
  expect(screen.getByRole("button", { name: "Send message" })).not.toBeDisabled();
});

it("keeps the draft after a timeout", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "AbortError"); }));
  const { onClose } = await openCompose();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Message could not be sent. Please try again."));
  expect(onClose).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText("Write your message…")).toHaveValue("Message");
});

it("refuses an empty broadcast audience without sending or closing", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { onClose } = await openCompose();
  fireEvent.click(screen.getByLabelText("Recipient type"));
  fireEvent.click(screen.getByRole("option", { name: "All residents" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Select at least one recipient."));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
