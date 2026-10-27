/**
 * Synthetic guest-message emails shaped like each booking site's notification. No real guest, listing or token: names are
 * made up and every relay address is a throwaway on the site's own domain.
 */
export type ChannelEmailFixture = {
  fromEmail: string;
  fromName: string;
  subject: string;
  text: string;
  replyTo: string | null;
  expect: {
    guestName: string;
    messageIncludes: string;
    listingTitleIncludes: string;
    reservationCode: string | null;
  };
};

export const AIRBNB_MESSAGE: ChannelEmailFixture = {
  fromEmail: "automated@airbnb.com",
  fromName: "Airbnb",
  subject: "New message from Jose Alaniz",
  replyTo: "k3f9a1c2d4@reply.airbnb.com",
  text: [
    "Jose Alaniz",
    "Re: Private room near UW - 5257 Brooklyn Ave Room 6",
    "Nov 12 - Nov 19, 2026 - 1 guest",
    "Reservation code: HMTESTCODE1",
    "",
    "Hi! Is early check-in possible? I land around 10am.",
    "",
    "Reply to this email to respond to Jose.",
    "View message: https://www.airbnb.com/hosting/inbox/123",
    "Airbnb, Inc., 888 Brannan St, San Francisco, CA 94103",
  ].join("\n"),
  expect: { guestName: "Jose Alaniz", messageIncludes: "early check-in", listingTitleIncludes: "5257 Brooklyn Ave Room 6", reservationCode: "HMTESTCODE1" },
};

export const BOOKING_MESSAGE: ChannelEmailFixture = {
  fromEmail: "noreply@booking.com",
  fromName: "Booking.com",
  subject: "New message from guest Maria L. about reservation 4012345678",
  replyTo: "mt-8d41f0@guest.booking.com",
  text: [
    "You have a new message from Maria L.",
    "Property: 4709A 8th Ave - Room 9",
    "Reservation number: 4012345678",
    "Check-in: Nov 14, 2026",
    "Check-out: Nov 21, 2026",
    "",
    "Message:",
    "Is there parking?",
    "",
    "Please reply to this email to answer your guest.",
    "Booking.com B.V., Herengracht 597, Amsterdam",
  ].join("\n"),
  expect: { guestName: "Maria L.", messageIncludes: "parking", listingTitleIncludes: "4709A 8th Ave - Room 9", reservationCode: "4012345678" },
};

export const PADSPLIT_MESSAGE: ChannelEmailFixture = {
  fromEmail: "no-reply@padsplit.com",
  fromName: "PadSplit",
  subject: "Darnell T. sent you a message",
  replyTo: null,
  text: [
    "Hi Host,",
    "Darnell T. sent you a message about 5259 Brooklyn Ave - Room 1:",
    "",
    "When can I move in?",
    "",
    "Reply: https://www.padsplit.com/host/messages/abc",
    "PadSplit, Inc. Atlanta, GA",
  ].join("\n"),
  expect: { guestName: "Darnell T.", messageIncludes: "move in", listingTitleIncludes: "5259 Brooklyn Ave - Room 1", reservationCode: null },
};

export const SPAREROOM_MESSAGE: ChannelEmailFixture = {
  fromEmail: "noreply@spareroom.com",
  fromName: "SpareRoom",
  subject: "New message from Aiko K. about 'Room near the University of Washington'",
  replyTo: "reply-71ab@spareroom.com",
  text: [
    "Aiko K. has sent you a message about your ad: Room near the University of Washington",
    "",
    "Which rooms are close to UW and when can I see one?",
    "",
    "Reply to this message from your SpareRoom inbox.",
    "SpareRoom Inc.",
  ].join("\n"),
  expect: { guestName: "Aiko K.", messageIncludes: "close to UW", listingTitleIncludes: "Room near the University of Washington", reservationCode: null },
};

export const ALL_CHANNEL_FIXTURES = [AIRBNB_MESSAGE, BOOKING_MESSAGE, PADSPLIT_MESSAGE, SPAREROOM_MESSAGE] as const;
