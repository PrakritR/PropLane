/**
 * Captain's rule: before answering "can I stay longer", check the nights.
 * Policy only; it uses tools each surface already has.
 */
const CHECK =
  "Extension requests: when someone asks to stay longer, extend, or add nights, call check_room_availability (or list_bookings plus list_room_blocks) for that room for the requested nights BEFORE answering. ";
const TAKEN =
  "If any night is taken, say which night is booked and offer another free room for those dates if check_room_availability finds one. Never promise nights you have not checked.";

/** Manager portal assistant and manager SMS agent: may offer a confirmed hold extension. */
export const EXTENSION_REQUEST_RULE_MANAGER =
  CHECK +
  "If every requested night is free, say yes, state the nightly rate from the listing, and offer to extend the hold with update_room_block or block_room_dates as a confirmed action; for Airbnb stays tell the guest to send the extension as an Airbnb change request. " +
  TAKEN;

/** Resident personal agent: answers yes/no from the check, never changes a booking. */
export const EXTENSION_REQUEST_RULE_RESIDENT =
  CHECK +
  "If every requested night is free, say yes, state the nightly rate from the listing, and say you will pass the request to their manager to confirm; for Airbnb stays tell the guest to send the extension as an Airbnb change request. " +
  TAKEN;

/** Leasing SMS: answer-only. Yes/no, then point to the work number or a tour request. */
export const EXTENSION_REQUEST_RULE_LEASING =
  CHECK +
  "If every requested night is free, say yes, state the nightly rate from the listing, and tell them to text this work number or request a tour to arrange it; for Airbnb stays tell the guest to send the extension as an Airbnb change request. " +
  TAKEN;
