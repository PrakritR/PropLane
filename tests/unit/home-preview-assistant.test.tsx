// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import { DEMO_TABS, type DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { PREVIEW_ASSISTANT_PROMPTS, previewAssistantAnswer } from "@/components/marketing/home-preview-assistant-data";
import { NO_STORY, residentStory, vendorStory, vendorPayments, vendorServices, worldFor } from "@/components/marketing/site/product-mock/world";
import { RESIDENT_NAME } from "@/components/marketing/site/product-mock/fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
const fetchSpy = vi.fn(() => { throw new Error("No preview network"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(portal: DemoPortal) {
  return render(<div className="rlp-page"><ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active="dashboard" onSelect={() => undefined} panel><p>Sample portal</p></ResidentLifecycleWorkspace></div>);
}

describe("fixture-only sample assistant", () => {
  it.each(["manager", "resident", "vendor"] as const)("%s: Ask opens real presentation; suggestions and Enter answer without network", async (portal) => {
    mount(portal);
    const entry = screen.getByRole("button", { name: /Ask PropLane or search/ });
    fireEvent.click(entry);
    const input = await screen.findByRole("textbox", { name: "Ask PropLane about this sample" }, { timeout: 15000 });
    expect(document.activeElement).toBe(input);
    const prompt = PREVIEW_ASSISTANT_PROMPTS[portal][0]!;
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    expect(await screen.findByText(previewAssistantAnswer(portal, prompt))).toBeTruthy();
    fireEvent.change(input, { target: { value: "Please send a reminder" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(previewAssistantAnswer(portal, "Please send a reminder"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Attach image or PDF" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "PropLane assistant" })).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it("real send button, New, and History operate only on mounted sample memory", async () => {
    const view = mount("resident");
    fireEvent.click(screen.getByRole("button", { name: /Ask PropLane or search/ }));
    const input = await screen.findByRole("textbox", { name: "Ask PropLane about this sample" }, { timeout: 15000 });
    fireEvent.change(input, { target: { value: "Is my rent paid?" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("log").textContent).toContain("paid");
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    expect(screen.queryByRole("log")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Past conversations" }));
    const history = await screen.findByRole("dialog", { name: "Past conversations" });
    fireEvent.click(within(history).getByRole("button", { name: /^Is my rent paid/ }));
    expect(screen.getByRole("log").textContent).toContain("paid");
    view.unmount();
    mount("resident");
    fireEvent.click(screen.getByRole("button", { name: /Ask PropLane or search/ }));
    await screen.findByRole("textbox", { name: "Ask PropLane about this sample" }, { timeout: 15000 });
    expect(screen.queryByRole("log")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives role-scoped answers from the same fixture rows and story", () => {
    const story = residentStory("pay");
    const overdue = worldFor(story).payments.filter((row) => row.bucket === "overdue");
    const answer = previewAssistantAnswer("manager", "Who is late on rent?", story);
    expect(answer).toContain(`${overdue.length} charges`);
    for (const row of overdue) expect(answer).toContain(row.resident);
    const services = previewAssistantAnswer("manager", "Which services are open?", story);
    for (const row of worldFor(story).services) {
      if (row.state === "done" || row.state === "declined") expect(services).not.toContain(row.title);
    }
    const resident = previewAssistantAnswer("resident", "Is my rent paid?", story);
    for (const row of worldFor(story).payments.filter((row) => row.resident !== RESIDENT_NAME)) expect(resident).not.toContain(row.resident);
    expect(previewAssistantAnswer("resident", "Is my rent paid?", NO_STORY)).toContain("no charges");
    expect(previewAssistantAnswer("resident", "Is my lease signed?", NO_STORY)).toContain("not been sent");
    const vendorSnapshot = vendorStory("visit");
    const open = vendorServices(vendorSnapshot).filter((row) => row.state === "open");
    const offered = previewAssistantAnswer("vendor", "What jobs are open?", vendorSnapshot);
    expect(offered).toContain(`${open.length} jobs`);
    for (const row of open) expect(offered).not.toContain(row.property);
    const paid = vendorPayments(vendorSnapshot).filter((row) => row.status === "Paid");
    expect(previewAssistantAnswer("vendor", "Which invoices are paid?", vendorSnapshot)).toContain(`${paid.length} invoices`);
    expect(previewAssistantAnswer("vendor", "Show all resident rent balances", vendorSnapshot)).not.toContain(overdue[0]!.resident);
  });
});
