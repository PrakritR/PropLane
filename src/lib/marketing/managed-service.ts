/**
 * PropLane Managed: we run an owner's home ourselves, on PropLane. One module
 * feeds /pricing (the fourth pricing option), /pricing/service, the Why PropLane
 * pages, llms.txt and the sitemap, so the offering is never described two ways.
 *
 * There is no price. The captain has not set one, so the honest label is
 * "Custom" and the way to learn more is to talk to us. Do not type a fee here;
 * when one exists it goes in `MANAGED_PRICE_HEADLINE` / `MANAGED_PRICE_NOTE`.
 */

export const MANAGED_SERVICE_HREF = "/#service";
export const MANAGED_CONTACT_HREF = "/#contact";
export const MANAGED_SERVICE_NAME = "PropLane Managed";
/** The Contact route topic this offering files under (see `TOPICS` in the contact page). */
export const MANAGED_SERVICE_TOPIC = "Property management services";

export const MANAGED_PRICE_HEADLINE = "Custom";
export const MANAGED_PRICE_NOTE = "Based on your home. Talk to us for a quote.";

export type ManagedInclude = { id: string; title: string; copy: string };

/** What is included, in the order an owner thinks about it. */
export const MANAGED_INCLUDES: readonly ManagedInclude[] = [
  {
    id: "leasing",
    title: "Leasing and tenant placement",
    copy: "We list the home, run tours, screen applicants and sign the lease, all in PropLane, so you can see every step.",
  },
  {
    id: "rent",
    title: "Rent collection",
    copy: "Charges, reminders and payments run through PropLane's ledger. Late rent is followed up on a fixed schedule.",
  },
  {
    id: "maintenance",
    title: "Maintenance and vendors",
    copy: "A repair request is routed to a vendor, quoted, scheduled and closed out. You are asked only when it needs an owner's approval.",
  },
  {
    id: "stays",
    title: "Short-term and room rentals",
    copy: "Airbnb-style stays and by-the-room leases, the way we run our own homes, with the calendars kept in sync.",
  },
  {
    id: "line",
    title: "A 24/7 texting line",
    copy: "Residents, vendors and prospects text one number. PropLane's assistant answers the routine questions and brings a person in for the rest.",
  },
  {
    id: "reporting",
    title: "Owner reporting",
    copy: "What came in, what went out and what is open, from the same books we use to run the home.",
  },
] as const;

export type ManagedStep = { id: string; title: string; copy: string };

export const MANAGED_STEPS: readonly ManagedStep[] = [
  {
    id: "talk",
    title: "Tell us about your home",
    copy: "Where it is, how many rooms, and what you want from it. Nothing to sign yet.",
  },
  {
    id: "plan",
    title: "We look and quote",
    copy: "We review the home and come back with how we would run it and what it would cost.",
  },
  {
    id: "run",
    title: "We run it on PropLane",
    copy: "Once you say yes, we set the home up in PropLane and manage it day to day. You get an owner view of everything.",
  },
] as const;

export const MANAGED_FAQ: readonly { q: string; a: string }[] = [
  {
    q: "What does PropLane Managed cost?",
    a: "It depends on the home: how many rooms, what kind of rental, and how much work it needs. We quote each home after we have looked at it, so there is no price list to misread. Use the form and we will come back with a number.",
  },
  {
    q: "Is this different from the software?",
    a: "It is the same software. With the software plans you run your own homes in PropLane. With PropLane Managed, our team runs your home in PropLane for you, and you can see all of it.",
  },
  {
    q: "Who actually manages my home?",
    a: "The people who built PropLane. We run Airbnb and room-rental homes in Seattle ourselves and built PropLane to do it. Your home goes into the same system and the same routine.",
  },
  {
    q: "Where do you manage homes?",
    a: "We are based in Seattle and our own homes are there. Tell us where your home is in the form and we will tell you plainly whether we can take it.",
  },
  {
    q: "Can I see what is going on with my home?",
    a: "Yes. Your home lives in PropLane, so rent, maintenance and messages are all recorded there, and you get an owner view of the same books we work from.",
  },
  {
    q: "Do I have to commit before I talk to you?",
    a: "No. The form only starts a conversation. We reply by email.",
  },
] as const;
