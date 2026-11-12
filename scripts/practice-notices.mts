/**
 * Renders (never sends) a realistic sample of every alert, digest and owner / staff notice text the managed-workspace
 * alerts work touches, so the copy can be reviewed:
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/practice-notices.mts
 *
 * No database, no Twilio, no email provider is reached: only the pure builders run.
 */
import { buildInboundAlertText } from "../src/lib/one-number/inbound-alert";
import { composeServiceDigest } from "../src/lib/one-number/service-digest";
import { checkinDigestLine } from "../src/lib/one-number/ops-alert-lines";
import { statementText } from "../src/lib/owner-management/monthly-statements.server";
import { composeServiceAlertText } from "../src/lib/service/service-manager-alerts.server";
import {
  ADMIN_INVITE_SUBJECT,
  buildAdminInviteBody,
  buildOwnerInviteBody,
  buildOwnerInviteText,
  buildServiceTeamInviteBody,
  buildServiceTeamInviteText,
  ownerInviteSubject,
  serviceTeamInviteSubject,
} from "../src/lib/co-manager-link-email";
import {
  buildAdminInviteText,
  buildSeatGrantedBody,
  buildSeatGrantedText,
  buildSeatRevokedBody,
  buildSeatRevokedText,
  seatGrantedSubject,
  seatRevokedSubject,
} from "../src/lib/admin-team/admin-team-notices";

const link = "https://proplane.ai/portal/communication/inbox/unopened";
const show = (title: string, body: string) => {
  const segments = body.length <= 160 ? 1 : Math.ceil(body.length / 153);
  console.log(`\n=== ${title}  [${body.length} chars, ~${segments} segment${segments === 1 ? "" : "s"}]\n${body}`);
};

console.log("INBOUND TEXT ALERTS (to PropLane's admin phones and the staff seats whose grants cover the house)");
show("Resident repair issue", buildInboundAlertText({ kind: "resident", name: "Vaishnavi Sharma", phone: "+12065550101", house: "5259 Brooklyn", body: "The toilet in room 3 is leaking, can someone come today?", link }));
show("Lead wanting a tour, house known", buildInboundAlertText({ kind: "prospect", name: "Maria Lopez", phone: "+12065550177", house: "4709A 8th Ave", body: "Hi is room 4 still available? Could I tour Saturday afternoon?", link }));
show("Stranger on the PropLane line, house not known", buildInboundAlertText({ kind: "unknown", phone: "+12065550188", house: null, body: "do you have any rooms near UW for january", link }));
show("The owner (Ambika) writes in", buildInboundAlertText({ kind: "owner", name: "Ambika Mago", phone: "+15105791976", house: null, body: "can you send my statement and how is rent this month?", link }));
show("A card number is never repeated", buildInboundAlertText({ kind: "resident", name: "Sam Lee", phone: "+12065550155", house: "5257 Brooklyn", body: "my card 4242 4242 4242 4242 keeps failing for rent, please charge it manually", link }));

console.log("\n\nDAILY 7 AM DIGEST (one text per person)");
const lines = [
  checkinDigestLine("5259 Brooklyn", [{ room: "Room 4", guest: "Anthony", channel: "Airbnb", time: "15:00" }], [{ room: "Room 7", guest: "Kumaran", channel: "Booking.com", time: "11:00" }]),
  checkinDigestLine("5257 Brooklyn", [], [{ room: "Room 2", guest: "Guest", channel: "Airbnb", time: "11:00" }]),
  checkinDigestLine("4709A 8th Ave", [{ room: "Room 6", guest: "Nina", channel: "Booking.com", time: "15:00" }], []),
];
const [full] = composeServiceDigest({ houseLines: lines, leads: [{ firstName: "Maria Lopez", house: "4709A 8th Ave" }, { firstName: null, house: null }, { firstName: "Sam", house: "5259 Brooklyn" }], remindersResidents: 9 });
show("Admin phone (every managed house), houses + leads + reminders", full!);
const [quiet] = composeServiceDigest({ houseLines: [], leads: [{ firstName: "Maria Lopez", house: "4709A 8th Ave" }] });
show("A seat holder on one workspace: only a lead", quiet!);
show("Nothing to say = no text", JSON.stringify(composeServiceDigest({ houseLines: [], leads: [] })));

console.log("\n\nSPINE NOTICES FOR A MANAGED WORKSPACE (listed alert phone, paid by PropLane)");
show("New booking, as the alert phone gets it", composeServiceAlertText({ workspaceName: "1. Ambika", subject: "New booking", text: "New booking - 5259 Room 2, Nov 6-9 (Airbnb)." }));
show("Application started", composeServiceAlertText({ workspaceName: "2. Vinod", subject: "Application started", text: "Application started - Vaishnavi S., 4709A." }));

console.log("\n\nOWNER (the client) NOTICES");
show("Monthly statement text (existing, on the 1st)", statementText({ monthKey: "2026-10", workspaceName: "1. Ambika", rentCents: 1165000, feeCents: 116500, vendorCents: 21264, netCents: 1027236, balanceCents: 1027236, link: "https://proplane.ai/portal/financials/owner-payouts" }));
console.log("\n(Routine events - approvals, tours, bookings, payment reminders - are NOT texted or threaded to the client owner any more.)");

console.log("\n\nSTAFF SEAT EMAIL (routine event, seat holder's account email; sent from the workspace work email)");
console.log("Subject: Application approved\nBody:    You approved Kumaran Chanthrakumar's application.\nLink:    /portal/applications\n(Viewer seat: same email, read-only link; a seat whose grants do not cover the house gets none.)");

console.log("\n\nATTENTION ITEM (a refused ops text, once per day per reason, in the service owner's Assistant + push + email; never a text)");
console.log("Subject: PropLane alert texts are not going out\nBody:    A daily digest text to PropLane's own phones was refused (comms_billing_allowance_exhausted). Check communication credit and the PropLane line in Admin > Service.");

console.log("\n\nTEAM CHAT LINE REPLACED BY THE DIGEST COUNT");
console.log("Before: 'Payment reminder sent: Late fee, 5259 Brooklyn Ave, Room 9, <resident>.' x9\nAfter:  'Payment reminders sent: 9 residents.' (one line inside the 7 AM digest)");

const mail = (title: string, subject: string, body: string) => console.log(`\n=== EMAIL: ${title}\nSubject: ${subject}\n\n${body}`);
const acceptUrl = "https://proplane.ai/invite/Zk3f9Qe1xT2mV8aR";
const openUrl = "https://proplane.ai/portal";

console.log("\n\n##### STAFF SEATS AND OWNER ONBOARDING (Nov 12): one email and at most one text per event #####");

console.log("\n\nSTAFF SEAT INVITE (a person who is added to help manage specific managed workspaces; text only when a mobile was typed AND consent allows)");
mail("seat invite, two workspaces", ADMIN_INVITE_SUBJECT, buildAdminInviteBody({ inviterName: "Prakrit", roleLabel: "Workspace admin", workspaceNames: ["1. Ambika", "2. Vinod"], acceptUrl, expiresInDays: 7 }));
show("TEXT: seat invite, two workspaces", buildAdminInviteText({ inviterName: "Prakrit", roleLabel: "Workspace admin", workspaceNames: ["1. Ambika", "2. Vinod"], acceptUrl }));
show("TEXT: seat invite, one workspace", buildAdminInviteText({ inviterName: "Prakrit", roleLabel: "Viewer", workspaceNames: ["2. Vinod"], acceptUrl }));
mail("Overall admin invite (primary admin only)", ADMIN_INVITE_SUBJECT, buildAdminInviteBody({ inviterName: "Prakrit", roleLabel: "Overall admin", workspaceNames: [], acceptUrl, expiresInDays: 7 }));
show("TEXT: Overall admin invite", buildAdminInviteText({ inviterName: "Prakrit", roleLabel: "Overall admin", workspaceNames: [], acceptUrl }));

console.log("\n\nSTAFF SEAT GRANTED (an existing account is given another workspace: one email naming only the new one)");
mail("seat granted", seatGrantedSubject(["2. Vinod"]), buildSeatGrantedBody({ inviterName: "Prakrit", roleLabel: "Property manager", workspaceNames: ["2. Vinod"], openUrl }));
show("TEXT: seat granted (verified phone only)", buildSeatGrantedText({ workspaceNames: ["2. Vinod"], openUrl }));

console.log("\n\nSTAFF SEAT REVOKED (alerts for those workspaces stop at the same moment)");
mail("seat revoked, two workspaces", seatRevokedSubject(["1. Ambika", "2. Vinod"]), buildSeatRevokedBody({ workspaceNames: ["1. Ambika", "2. Vinod"] }));
show("TEXT: seat revoked (verified phone only)", buildSeatRevokedText({ workspaceNames: ["1. Ambika", "2. Vinod"] }));

console.log("\n\nSTAFF INVITE FROM A WORKSPACE'S OWN TEAM PANE (Admin > Service, person with no account yet)");
mail("service team invite", serviceTeamInviteSubject("2. Vinod"), buildServiceTeamInviteBody({ workspaceName: "2. Vinod", roleLabel: "Property manager", acceptUrl }));
show("TEXT: service team invite", buildServiceTeamInviteText({ workspaceName: "2. Vinod", roleLabel: "Property manager", acceptUrl }));

console.log("\n\nOWNER ONBOARDING (the client; lands view-only in the Property portal)");
mail("owner onboarding", ownerInviteSubject("1. Ambika"), buildOwnerInviteBody({ ownerName: "Ambika Mago", workspaceName: "1. Ambika", acceptUrl }));
show("TEXT: owner onboarding (mobile given and consent allows)", buildOwnerInviteText({ workspaceName: "1. Ambika", acceptUrl }));
