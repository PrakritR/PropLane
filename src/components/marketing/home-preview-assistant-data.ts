import type { DemoPortal } from "./site/product-mock/demo-nav";
import { RESIDENT_HOME, RESIDENT_NAME } from "./site/product-mock/fixtures";
import { residentHomeProgress, residentLeases, residentStory, vendorPayments, vendorServices, vendorStory, worldFor, type DemoStory } from "./site/product-mock/world";

export const PREVIEW_ASSISTANT_PROMPTS: Record<DemoPortal, string[]> = {
  manager: ["Who is late on rent?", "What tours are coming up?", "Which services are open?"],
  resident: ["Is my rent paid?", "What is left for my move-in?", "Is my lease signed?"],
  vendor: ["What jobs are scheduled?", "Which invoices are paid?", "What jobs are open?"],
};

/** Fixture-only answers. There is deliberately no agent, tool, session, or persistence here. */
export function previewAssistantAnswer(portal: DemoPortal, question: string, snapshot?: DemoStory): string {
  const story = snapshot ?? (portal === "vendor" ? vendorStory("visit") : residentStory("pay"));
  const text = question.toLowerCase();
  const sample = (answer: string) => `In this sample, ${answer}`;
  if (/\b(send|delete|charge|refund|approve|book|cancel|update|change|dispatch|create)\b/.test(text)) {
    return "This preview can explain the sample records. It cannot send a message, change a record, or take a payment.";
  }
  if (portal === "manager") {
    const world = worldFor(story);
    if (/rent|late|payment|overdue/.test(text)) {
      const rows = world.payments.filter((row) => row.bucket === "overdue");
      return sample(rows.length ? `${rows.length} charges are overdue: ${rows.map((row) => `${row.resident} — ${row.chargeTitle}, ${row.amount} (${row.property})`).join("; ")}.` : "no charges are overdue.");
    }
    if (/tour|calendar|schedule/.test(text)) {
      const rows = world.tours.filter((row) => row.bucket === "upcoming");
      return sample(rows.length ? `${rows.length} tours are upcoming: ${rows.map((row) => `${row.guest} — ${row.place}, ${row.when}`).join("; ")}.` : "there are no upcoming tours.");
    }
    if (/service|repair|maintenance/.test(text)) {
      const rows = world.services.filter((row) => row.state === "open");
      return sample(rows.length ? `${rows.length} services are still open: ${rows.map((row) => `${row.title} — ${row.property} (${row.state})`).join("; ")}.` : "there are no open services.");
    }
  } else if (portal === "resident") {
    if (/rent|pay|balance/.test(text)) {
      const rows = worldFor(story).payments.filter((row) => row.resident === RESIDENT_NAME);
      return sample(rows.length ? rows.map((row) => `your ${row.chargeTitle.toLowerCase()} is ${row.bucket} — ${row.amount}`).join("; ") + "." : "there are no charges on your account yet.");
    }
    if (/lease|sign/.test(text)) {
      const rows = residentLeases(story);
      return sample(rows.length ? `your lease is ${rows[0]!.label.toLowerCase()}.` : "your lease has not been sent yet.");
    }
    if (/move|home|checklist/.test(text)) {
      const remaining = residentHomeProgress(story).checklist.filter((row) => !row.done);
      return sample(`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room} is your home. ${remaining.length ? `Still to do: ${remaining.map((row) => row.label).join("; ")}.` : "Your move-in checklist is complete."}`);
    }
  } else {
    if (/invoice|paid|payment|money/.test(text)) {
      const rows = vendorPayments(story).filter((row) => row.status === "Paid");
      return sample(`${rows.length} invoices are paid: ${rows.map((row) => `${row.title} — ${row.amount}`).join("; ")}.`);
    }
    if (/job|service|schedule|work/.test(text)) {
      const state = /open|offer|find/.test(text) ? "open" : "scheduled";
      const rows = vendorServices(story).filter((row) => row.state === state);
      // Offered work never reveals an address, unit, or resident from the manager's world.
      return sample(rows.length ? `${rows.length} jobs are ${state}: ${rows.map((row) => `${row.title} — ${row.fact}${row.hired ? ` (${row.property}${row.unit ? ` · ${row.unit}` : ""})` : ""}`).join("; ")}.` : `there are no ${state} jobs.`);
    }
  }
  return `Try a question about the sample ${portal === "manager" ? "rent, tours, or services" : portal === "resident" ? "rent, lease, or move-in checklist" : "jobs or invoices"}. These answers use only the records in this preview.`;
}
