/**
 * Fixture data for the home demo's pop-ups and record views (`demo-popups-*.tsx`). Everything here is
 * Seattle Homes sample data: no real person, no real address, no photo. Counts a pop-up prints are
 * derived from these rows, never typed beside them.
 */

import type { ManagerFormFixture } from "@/components/marketing/site/product-mock/fixtures-more";
import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";

/** A question as the real form model holds it (`MoveInFormQuestion`), written short. */
function q(key: string, label: string, type: MoveInFormQuestion["type"], required: boolean, section?: string, options: string[] = []): MoveInFormQuestion {
  return { id: `q-${key}`, key, label, type, required, options, ...(section ? { section } : {}) };
}

/** A resident the manager can send a form to (current or upcoming), as the Send a form pop-up lists them. */
export type DemoResidency = { id: string; name: string; place: string };

export const DEMO_RESIDENCIES: DemoResidency[] = [
  { id: "res-liam", name: "Liam Foster", place: "Alder House · Room 1" },
  { id: "res-maya", name: "Maya Chen", place: "Maple Duplex · Unit B" },
  { id: "res-dana", name: "Dana Reyes", place: "Maple Duplex · Unit A" },
  { id: "res-tomas", name: "Tomas Alvarez", place: "Willow Court · Room 2" },
];

/** The forms a property offers by name (what "Form" lists once a resident is picked), with the due day its rule gives. */
export const DEMO_SENDABLE_FORMS: { id: string; name: string; due: string }[] = [
  { id: "form-intake", name: "Intake form", due: "2025-10-02" },
  { id: "form-key", name: "Key receipt", due: "2025-09-30" },
  { id: "form-checklist", name: "Move-in checklist", due: "2025-10-02" },
  { id: "form-pet", name: "Pet agreement", due: "2025-10-02" },
];

export type DemoFormDetail = {
  sent: string;
  due: string;
  reminded?: string;
  opened?: string;
  submitted?: string;
  /** Question key -> what the resident answered (completed forms). */
  answers?: Record<string, string>;
  pdfName?: string;
  questions: MoveInFormQuestion[];
};

/** What each fixture form holds: its questions, and the resident's answers when it came back. */
export const DEMO_FORM_DETAILS: Record<string, DemoFormDetail> = {
  "mform-priya-intake": {
    sent: "Sep 20, 2025, 9:12 AM",
    due: "Sep 27, 2025",
    questions: [
      q("legal-name", "Legal name", "text", true, "About you"),
      q("phone", "Phone number", "phone", true, "About you"),
      q("emergency", "Emergency contact", "text", true, "Emergency contact"),
      q("arrival", "Expected arrival", "date", false, "Move-in"),
      q("signature", "Signature", "signature", true, "Move-in"),
    ],
  },
  "mform-liam-key": {
    sent: "Sep 13, 2025, 4:30 PM",
    due: "Sep 20, 2025",
    reminded: "Sep 19, 2025, 10:00 AM",
    questions: [
      q("keys", "Keys received", "select", true, undefined, ["1", "2", "3"]),
      q("fob", "Building fob received", "yes_no", true),
      q("signature", "Signature", "signature", true),
    ],
  },
  "mform-dana-checklist": {
    sent: "Sep 17, 2025, 11:05 AM",
    due: "Sep 24, 2025",
    opened: "Sep 24, 2025, 2:41 PM",
    submitted: "Sep 24, 2025, 1:58 PM",
    pdfName: "Move-in checklist - Dana Reyes.pdf",
    questions: [
      q("walls", "Walls and paint", "select", true, "Condition", ["Good", "Minor wear", "Needs repair"]),
      q("appliances", "Appliances working", "yes_no", true, "Condition"),
      q("notes", "Anything to note", "long_text", false, "Condition"),
      q("signature", "Signature", "signature", true, "Sign-off"),
    ],
    answers: { walls: "Minor wear", appliances: "Yes", notes: "Small scuff by the hallway door", signature: "Dana Reyes" },
  },
  "mform-maya-pet": {
    sent: "Sep 2, 2025, 8:20 AM",
    due: "Sep 9, 2025",
    opened: "Sep 9, 2025, 6:12 PM",
    submitted: "Sep 9, 2025, 5:47 PM",
    pdfName: "Pet agreement - Maya Chen.pdf",
    questions: [
      q("pet-name", "Pet name", "text", true, "Your pet"),
      q("pet-kind", "Kind of pet", "select", true, "Your pet", ["Dog", "Cat", "Other"]),
      q("vaccinated", "Vaccinations up to date", "yes_no", true, "Your pet"),
      q("signature", "Signature", "signature", true, "Agreement"),
    ],
    answers: { "pet-name": "Biscuit", "pet-kind": "Cat", vaccinated: "Yes", signature: "Maya Chen" },
  },
};

export function demoFormDetail(form: Pick<ManagerFormFixture, "id">): DemoFormDetail {
  return DEMO_FORM_DETAILS[form.id] ?? DEMO_FORM_DETAILS["mform-liam-key"]!;
}
