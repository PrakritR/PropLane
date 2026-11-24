/**
 * A short alias of the room export feed (`/ical/<token>.ics`), for importers that cap or pattern-match the link they are
 * pasted. Same handler, same token authority: nothing here reads or writes anything of its own.
 */
export { GET, HEAD } from "@/app/api/calendar/export/[token]/route";

export const runtime = "nodejs";
