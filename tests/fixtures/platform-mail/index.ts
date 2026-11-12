/**
 * Synthetic platform-inquiry mails (design-1112 §6), shaped like each site's notification from its KNOWN format. No real
 * prospect, listing or token: names are made up, relay addresses are throwaways on the site's own domain. NONE of these is a
 * real captured mail (none was available), which is why every site but SpareRoom ships its own parser OFF.
 */
export type PlatformMailFixture = {
  fromEmail: string;
  fromName: string;
  subject: string;
  text: string;
  replyTo: string | null;
  expect: { site: string; senderName: string; bodyIncludes: string; listingIncludes: string | null; phone: string | null };
};

export const SPAREROOM_INQUIRY: PlatformMailFixture = {
  fromEmail: "noreply@spareroom.com",
  fromName: "SpareRoom",
  subject: "New message from Aiko K. about 'Room 9 at 4709a 8th Ave NE'",
  replyTo: "reply-71ab@spareroom.com",
  text: [
    "Aiko K. has sent you a message about your ad: Room 9 at 4709a 8th Ave NE",
    "",
    "Hi, is this room still available for December? You can also reach me on (425) 555-0188.",
    "",
    "Reply to this message from your SpareRoom inbox.",
    "SpareRoom Inc.",
  ].join("\n"),
  expect: { site: "spareroom", senderName: "Aiko K.", bodyIncludes: "still available for December", listingIncludes: "4709a", phone: "+14255550188" },
};

export const ROOMIES_INQUIRY: PlatformMailFixture = {
  fromEmail: "notifications@roomies.com",
  fromName: "Roomies",
  subject: "New message from Dana Cruz on Roomies",
  replyTo: null,
  text: ["Dana Cruz sent you a message about Room 3 near UW, 5257 Brooklyn Ave:", "", "Is the room furnished and how much is the deposit?", "", "View conversation: https://www.roomies.com/messages/ab12cd34", "Roomies Inc."].join("\n"),
  expect: { site: "roomies", senderName: "Dana Cruz", bodyIncludes: "furnished", listingIncludes: "Room 3", phone: null },
};

export const ZILLOW_INQUIRY: PlatformMailFixture = {
  fromEmail: "noreply@convo.zillow.com",
  fromName: "Zillow Rentals",
  subject: "Priya Nair is interested in 5259 Brooklyn Ave NE",
  replyTo: "c-9f31@convo.zillow.com",
  text: ["Priya Nair is interested in 5259 Brooklyn Ave NE", "Name: Priya Nair", "Message: Hello, can I tour Room 4 this weekend? Text me at 206-555-0133.", "", "Reply to this email to respond.", "Zillow, Inc."].join("\n"),
  expect: { site: "zillow", senderName: "Priya Nair", bodyIncludes: "tour Room 4", listingIncludes: "5259", phone: "+12065550133" },
};

export const CRAIGSLIST_INQUIRY: PlatformMailFixture = {
  fromEmail: "abc123xyz@reply.craigslist.org",
  fromName: "craigslist",
  subject: "Re: Furnished room near UW - Room 6 - $1100 (University District)",
  replyTo: "abc123xyz@reply.craigslist.org",
  text: ["Hi, I'm a grad student looking for a room starting January. Is Room 6 open?", "", "Original craigslist post: https://seattle.craigslist.org/see/roo/d/000.html"].join("\n"),
  expect: { site: "craigslist", senderName: "Craigslist lead", bodyIncludes: "grad student", listingIncludes: "Room 6", phone: null },
};

export const FACEBOOK_INQUIRY: PlatformMailFixture = {
  fromEmail: "notification@facebookmail.com",
  fromName: "Facebook",
  subject: "Marco Silva sent you a message about \"Room for rent near UW\"",
  replyTo: null,
  text: ["Marco Silva sent you a message about \"Room for rent near UW\"", "", "Is this still available? I can move in Dec 1.", "", "View conversation", "Meta Platforms, Inc."].join("\n"),
  expect: { site: "facebook", senderName: "Marco Silva", bodyIncludes: "move in Dec 1", listingIncludes: "Room for rent near UW", phone: null },
};

export const ROOMSTER_INQUIRY: PlatformMailFixture = {
  fromEmail: "no-reply@roomster.com",
  fromName: "Roomster",
  subject: "Lena Park sent you a message on Roomster",
  replyTo: null,
  text: ["Lena Park sent you a message on Roomster", "Listing: Sunny room, 4709a 8th Ave NE Room 9", "", "Hi! Does the rent include utilities?", "", "Roomster Inc."].join("\n"),
  expect: { site: "roomster", senderName: "Lena Park", bodyIncludes: "utilities", listingIncludes: "Room 9", phone: null },
};

export const ALL_PLATFORM_FIXTURES = [SPAREROOM_INQUIRY, ROOMIES_INQUIRY, ZILLOW_INQUIRY, CRAIGSLIST_INQUIRY, FACEBOOK_INQUIRY, ROOMSTER_INQUIRY] as const;
