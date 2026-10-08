import type { GrowthAngle, GrowthFormat } from "./types";

/** 24 seed ideas across the five angles. Inserted once when growth_ideas is empty. */
export const SEED_IDEAS: Array<{ title: string; angle: GrowthAngle; format: GrowthFormat; notes: string }> = [
  { title: "A property manager's real job is relaying messages", angle: "positioning", format: "reel", notes: "Residents tell the manager, the manager tells the vendor, the vendor tells the manager, the manager tells the owner. Show the relay as a switchboard; PropLane drafts every relay, the manager approves." },
  { title: "Stop being a glorified middleman", angle: "positioning", format: "carousel", notes: "Five slides: the relay chain, what it costs in hours, the same chain with PropLane drafting each hop, the approve tap, the ask." },
  { title: "Your software shouldn't make you the switchboard", angle: "positioning", format: "text", notes: "Short LinkedIn post: most PM software stores records; the work is relaying. PropLane drafts the relay, you approve." },
  { title: "Software that drafts, you approve", angle: "positioning", format: "reel", notes: "Show the manager approving a drafted reply instead of typing it. One ask: try it." },
  { title: "The assistant drafts, you approve", angle: "feature", format: "reel", notes: "A resident texts a question; the assistant drafts the reply; the manager taps approve. Nothing sends without approval." },
  { title: "Rent reminder in one tap", angle: "feature", format: "reel", notes: "Manager sees who is late, one tap sends the reminder drafted in their voice." },
  { title: "Every application in one view", angle: "feature", format: "carousel", notes: "Applications, screening status and documents on a single screen instead of five inboxes." },
  { title: "Tour booked by text", angle: "feature", format: "reel", notes: "A prospect texts to see a unit; the assistant proposes slots; the manager confirms; the tour lands on the calendar." },
  { title: "The leak at 11pm", angle: "feature", format: "reel", notes: "A resident reports a leak at night; the assistant gathers details, drafts the vendor request, and holds it for the manager to approve." },
  { title: "One inbox for residents, vendors and owners", angle: "feature", format: "image", notes: "A product shot of the unified inbox with a drafted reply waiting for approval." },
  { title: "What 'approve' means in PropLane", angle: "feature", format: "text", notes: "Explain that drafts never send on their own; the manager is always the last step." },
  { title: "Five lease clauses small landlords skip", angle: "tips", format: "carousel", notes: "Late fee grace period, entry notice, subletting, guest stays, move-out cleaning standard. Not legal advice; check local law." },
  { title: "Tenant screening basics for small landlords", angle: "tips", format: "carousel", notes: "Consistent written criteria, apply them to everyone, document the reason for any denial, know your local rules." },
  { title: "Move-in checklist: the first 30 minutes", angle: "tips", format: "image", notes: "Walk-through photos, meter readings, keys count, smoke detector test, signed condition report." },
  { title: "The move-in checklist small landlords forget", angle: "tips", format: "carousel", notes: "Photos dated, utilities transferred, emergency contacts, trash and parking rules, how to report maintenance." },
  { title: "Write down your maintenance response times", angle: "tips", format: "text", notes: "Setting expectations in the lease prevents most 'why is nobody answering' texts." },
  { title: "Why you should screen every applicant the same way", angle: "tips", format: "text", notes: "Consistency is the simplest protection you have. A written checklist beats memory." },
  { title: "Seattle rent by the room, explained", angle: "local", format: "reel", notes: "How room-by-room rentals work in Seattle shared houses and how a manager keeps four leases straight." },
  { title: "Running a Seattle shared house", angle: "local", format: "carousel", notes: "Per-room rent, shared utilities split, house rules, one place for all four residents' requests." },
  { title: "Rent by the room is a Seattle thing", angle: "local", format: "text", notes: "Why many Seattle small landlords rent by the room and what makes it hard to manage in spreadsheets." },
  { title: "Why we built PropLane", angle: "founder", format: "text", notes: "The founders watched property managers spend the day relaying messages. We built the assistant that drafts each relay." },
  { title: "The relay problem, in 30 seconds", angle: "founder", format: "reel", notes: "A founder-voice explanation of the switchboard problem and the decision to keep the manager as approver." },
  { title: "What we got wrong building this", angle: "founder", format: "carousel", notes: "An honest list of early assumptions about property managers that did not survive talking to them." },
  { title: "Building PropLane in Seattle", angle: "founder", format: "image", notes: "A simple card: who we build for (small landlords and managers) and why drafting beats automating." },
];
