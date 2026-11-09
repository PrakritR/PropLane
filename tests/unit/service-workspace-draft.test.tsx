// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearAllWorkspaceDrafts, useWorkspaceDraft } from "@/components/portal/add-workspace/draft";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "session" }) }));
function Form({ open, actor, context }: { open: boolean; actor: string; context: string }) {
  const [value, setValue] = useState("");
  const draft = useWorkspaceDraft({ scope: `service:${JSON.stringify([context])}`, actor, open, value, restore: setValue, initialize: () => setValue(`default:${context}`) });
  return open ? <><input aria-label="Service" value={value} onChange={(event) => setValue(event.target.value)} /><button onClick={draft.clear}>Discard</button></> : null;
}
afterEach(() => { cleanup(); clearAllWorkspaceDrafts(); });
it("restores same-context drafts and isolates actor and property context", () => {
  const view = render(<Form open actor="a" context="house-a" />);
  expect(screen.getByLabelText("Service")).toHaveValue("default:house-a");
  fireEvent.change(screen.getByLabelText("Service"), { target: { value: "Kitchen repair" } });
  view.rerender(<Form open={false} actor="a" context="house-a" />);
  view.rerender(<Form open actor="a" context="house-a" />);
  expect(screen.getByLabelText("Service")).toHaveValue("Kitchen repair");
  view.rerender(<Form open={false} actor="a" context="house-a" />);
  view.rerender(<Form open actor="a" context="house-b" />);
  expect(screen.getByLabelText("Service")).toHaveValue("default:house-b");
  view.rerender(<Form open={false} actor="a" context="house-b" />);
  view.rerender(<Form open actor="b" context="house-a" />);
  expect(screen.getByLabelText("Service")).toHaveValue("default:house-a");
  fireEvent.click(screen.getByText("Discard"));
  view.rerender(<Form open={false} actor="b" context="house-a" />);
  view.rerender(<Form open actor="b" context="house-a" />);
  expect(screen.getByLabelText("Service")).toHaveValue("default:house-a");
});
it("consumes Escape when closing the select so the surrounding wizard stays open", () => {
  const close = vi.fn();
  const onWindow = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) close(); };
  window.addEventListener("keydown", onWindow);
  render(<FieldSingleSelect label="Property" value="" onChange={() => {}} options={[{ value: "a", label: "House A" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Property" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
  window.removeEventListener("keydown", onWindow);
});
