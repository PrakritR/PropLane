# PropLane One-Number Build Spec (captain, Oct 18 2026)

> The captain's spec, kept verbatim in substance. The implementation map — what
> was built where, and what each rule maps to in code — is
> [`one-number.md`](one-number.md). Read both before touching the shared line.

## Overview

PropLane runs on one phone number. Residents, prospects, managers and vendors all
text it, and an AI agent handles each person based on who they are. Every action
that needs more than text (applying, paying rent, viewing photos) goes through a
secure link tied to that phone number.

**Why:** one number is the whole product. We post it on signs, flyers, listings
and social media with a single call to action: "Text (XXX) XXX-XXXX to find a
room." No app download is needed to get started. Everyone can also use the
PropLane app, signed in with their phone number, and it shows the same
conversation.

**Success for v1:**

- A stranger texts the number from a flyer and ends up with a booked tour or a
  submitted application, with no human involved.
- Residents pay rent and report maintenance (with photos) by text.
- Managers run day-to-day operations by texting the same number.
- Vendors receive jobs and send completion photos by text.

## Users and roles

Every phone number maps to one contact, and each contact has one or more roles.
An unknown number defaults to Prospect.

| Role | Who | What they do by text | Links they get |
| --- | --- | --- | --- |
| Prospect | Anyone who texts from a flyer or listing | Search rooms, ask questions, see photos, book tours, apply | Gallery, tour booking, application |
| Resident | Signed tenant | Pay rent, report maintenance with photos, ask house questions, move-in and move-out photos | Rent payment, lease, move-in checklist |
| Manager | Us and later owner clients | Check tours, bookings, vacancies, payments; update rooms; message residents | Dashboard deep links |
| Vendor | Cleaners, plumbers, handymen | Receive jobs, accept or decline, send before and after photos, invoice | Job details, invoice upload |

One person can hold several roles (a resident who is also a vendor) — see the router.

## App and sign-in

The app and the text number are two doors into the same account. The phone
number is the account's identity, so anyone who has ever texted us sees their
full history the first time they sign in.

- A verified phone number is required for every account. Sign-in is by one-time
  code to that number.
- Google and Apple sign-in are optional extras. After either one, the app asks
  for a phone number and verifies it before the account opens. Apple sign-in
  must be offered on iOS whenever Google is.
- If the verified number already exists in contacts (they texted us first), the
  login attaches to that contact. No duplicate accounts.
- Changing the phone number requires a code to the old number and a code to the
  new one, or a manager reset.

| Role | Main screens |
| --- | --- |
| Prospect | Chat with the agent, saved rooms with photo galleries, tour bookings, application status |
| Resident | Chat, pay rent and payment history, maintenance tickets with photos, lease and house info, move-in and move-out photos |
| Manager | Inbox of all threads, vacancies, tours, rent status, tickets, approvals, broadcast |
| Vendor | Job list, job details and photos, upload before and after photos, invoices and payouts |

**One conversation, two channels:** the chat in the app is the same thread as
SMS. When a user has the app installed, routine messages go by push instead of
SMS. Codes are sent through our own SMS provider via Supabase's custom SMS hook,
not a per-verification service.

## Core router

One Twilio webhook receives every message. The router decides who is texting
before any AI writes a reply. Getting the role wrong could show a prospect
resident info.

- **Keywords first:** STOP, HELP and START are handled by code, never the AI.
  HUMAN pauses the AI and pages a manager. Emergency words trigger the safety
  reply and a manager alert.
- **Multiple roles:** use the thread's current role. If the message clearly fits
  the other role, switch. If unclear, ask: "Is this about your room or a job?"
- **Each agent** is the same model with a different system prompt and tool set.
  A prospect agent can't read resident data; only the manager agent changes data.
- **Speed:** reply within a few seconds; send a quick "one sec" if a lookup will
  take longer.

## Team routing: one number, many management teams

Every message is stamped with a workspace before anyone can see it. First match wins:

1. **Team member:** sender's phone belongs to a manager/co-manager of a
   workspace → manager agent for that workspace. Several teams → the team they
   last texted about, or ask.
2. **Resident:** active lease or resident binding → that workspace.
3. **Vendor:** open job → the job's workspace.
4. **Applicant:** open application → that workspace.
5. **Returning prospect:** existing prospect thread with a workspace → continue there.
6. **New prospect with a code:** every flyer/sign/listing carries a short code
   ("Text BROOKLYN5 to…") or a link that prefills the text. Code → property → workspace.
7. **New prospect, no code:** qualified in a PropLane-only "Unassigned leads"
   queue. Visible to a team only when the prospect picks or tours one of that
   team's rooms.

**Same person, two teams:** one continuous text thread for the person; each team
sees only messages stamped with its workspace. Ambiguous → "Is this about 5259
Brooklyn or your job at 8th Ave?"

**Inside a team:** co-managers who only run certain houses see only those
houses' threads (existing property access settings).

**Team alert numbers:** alerts (new lead, emergency, HUMAN) go only to that
team's listed numbers and app users.

**Outbound:** a manager reply from the inbox sends from the one number with a
short sign-off ("— 5259 Brooklyn team").

**Hard rule:** the database enforces workspace scoping, not just the UI.
Automated tests prove a manager in team A can never read, search or be alerted
about team B's threads.

## AI learning

The agents improve by building an approved knowledge base and a test set from
real conversations — not retraining. Nothing a texter says becomes an answer
until a manager approves it.

1. **Answer from facts only:** per-property knowledge base (Wi-Fi, parking, trash
   days, house rules, utilities, pets, fees, tour access) + live database. Never guess.
2. **Escalate when unsure** — and always for money, legal, safety, fair housing.
3. **Capture the human answer:** a manager answer to an escalated question or an
   edit of an AI draft becomes a suggested knowledge entry.
4. **One-tap approval** in the inbox or by text ("Save this answer for 5259? YES").
   Per property, or team-wide.
5. **Reuse:** next time the agent answers on its own.
6. **Lock in with tests:** every approved correction becomes a test case.

**Evaluation set:** from existing agent sessions/messages and live SMS
conversations, PII stripped, labelled, kept as a replay suite every prompt/model
change must pass: right facts, tone, one segment where possible, correct
escalation, no cross-team leaks, no fair-housing problems.

**Auto-reply modes per team and per topic:** Draft (agent writes, manager sends —
default for a new topic's first two weeks) → Auto with review → Full auto (when
corrections stay under e.g. 2% over the last 100 replies). Topics move up
automatically and drop back if corrections rise.

**Weekly:** resolved-without-human share, escalation rate, correction rate by
topic, time to first reply, tours per lead, opt-outs; a weekly digest to each
team of its top unanswered questions.

## Prospect flow (first text → booked tour in under five minutes)

1. First text → short welcome, STOP/HELP notice, first question.
2. Qualify one question at a time: budget; move-in date and lease length;
   area/commute; room type (private/shared bath, furnished); household size.
3. Match live vacancies → top 2–3, each with price, area, available date, one
   MMS photo and a gallery link.
4. Answer questions from listing data (no personal details about residents).
5. Tour: offer open slots, book, confirm, reminder 2 hours before, self-tour code
   or manager alert.
6. Apply: signed application link prefilled with phone and answers.
7. Screening and lease: background check, manager approval by text, lease
   signing link, deposit + first month via Stripe.
8. Convert: on payment the role flips Prospect → Resident, onboarding text goes out.

Follow-ups: one nudge at 24h, one at 72h, then stop. A new matching room later →
text once.

## Resident flow

Onboarding (house info, move-in checklist link, move-in photos); rent reminder 3
days before due with a Stripe link, receipt on payment, late notice the day
after + manager alert; maintenance by text + photo with urgency triage
(emergency/urgent/routine) and a ticket; house questions from the property info;
broadcast notices; move-out confirmation, photos, deposit status; HUMAN pauses
the AI until a manager hands it back.

## Manager flow

Plain English; anything that changes data needs a YES within 10 minutes.

| Example | Confirm? |
| --- | --- |
| "Who's touring tomorrow?" / "What's vacant at 5259 Brooklyn?" / "Who hasn't paid October rent?" | No |
| "Mark room 3 at 4709A rented to Sam from Nov 1" / "Drop room 2 price to $950" / "Approve Priya's application" / "Text all 5257 residents: …" / "Send the plumber to the 8th Ave leak" | Yes |

Alerts: new applications, booked tours, emergency maintenance, failed/late
payments, HUMAN requests, unanswerable questions. Daily digest at 8am: tours
today, open tickets, rent status, new leads.

## Vendor flow

Job offer by text (YES with a time / NO) → accept → resident confirm + access
details → reminder 1h before → before/after photos + "done" → resident confirms
fix → invoice by amount or photo → manager approves by YES → payment. Decline or
no answer within a set time → next vendor on the list. New vendors texting
"I do cleaning in Seattle" → collect trade, area, rates, insurance → manager approval.

## Photos (MMS)

Outbound: 1–2 listing photos per match; a no-login gallery link for the rest.
Inbound: resident maintenance → ticket; move-in/out → room condition record;
vendor before/after → job record (+ resident confirmation); manager new listing
photos → listing gallery. Every inbound file is downloaded immediately into the
private `sms-media` bucket and attached; the AI reads maintenance photos to rate
urgency. Never public; viewed only through expiring signed links.

## Links tied to the phone number

| Link | Who | Expires | One-time code? |
| --- | --- | --- | --- |
| Listing gallery | Prospects | 30 days | No |
| Tour booking | Prospects | 7 days | No |
| Application | Prospects | 7 days | Yes |
| Lease signing | Approved applicants | 7 days | Yes |
| Rent payment | Residents | Until paid or 10 days | Yes |
| Move-in checklist | New residents | 14 days | Yes |
| Job details | Vendors | Until job closes | No |

Short token → DB row (contact, purpose, target, expiry). No PII in the URL.
Protected link → 6-digit code to the same phone. Rent links create Stripe
Checkout with resident + invoice ids in metadata; the webhook marks paid and
texts a receipt. "send my rent link" / "resend application" resend.

**Three ways to do anything:** texted link (already bound); public link
(proplane.ai/apply/brooklyn5 — asks for phone, texts a code, then bound); all by
text where no form is needed.

**Code rules:** 10-minute expiry, 5 attempts, ≤3 sends/hour/phone, stored hashed.
Verified page session: 30 minutes for money, 7 days otherwise. Reuse the existing
phone verification table.

**Bank details never go over text.** A texted account/card number is not
repeated, is deleted from the stored message, and the reply is the secure link.

## Payments and payouts

The payout plumbing exists but nobody is connected. Finish onboarding and prove
each money path; do not build a new system. Rent → owner's connected account
(destination charge, application fee); application fee → manager's connected
account; vendor invoice → platform charge then transfer to vendor; PropLane fee →
normal charge. "set up payouts" by text → code-protected link → Stripe hosted
onboarding → account webhook → "Payouts are set up to the account ending 4417."
Only last 4 + status stored. Vendor invoice approval by YES, held until the
vendor finishes onboarding. Every money event posts once to the ledger via the
idempotent action events; daily reconciliation alerts on mismatch.

## Data model (spec names → build on existing tables)

| Spec | Existing table(s) | Change |
| --- | --- | --- |
| contacts | profiles, manager_sms_contacts | global contact keyed on E.164 phone, backfilled |
| roles | profile_roles, resident_workspace_bindings, manager_property_access | read by the router; add vendor + applicant lookups |
| conversations | sms_projection_conversations | identity: workspace + phone + role on the shared line; old keys in sms_projection_aliases |
| messages | sms_projection_turns, sms_outbox, sms_delivery_*, sms_inbound_receipts | every turn stamped with workspace_id |
| property tags | manager_sms_conversation_houses | house-level visibility |
| numbers | manager_sms_numbers, workspace_work_numbers | one shared row; old rows → grace → release |
| alert phones | workspace_work_number_recipients | alert list per team |
| consent | sms_consent, sms_consent_events | opt-outs carry over |
| prospects/tours | prospect_sms_*, prospect_tour_* | entry codes + Unassigned leads queue |
| pending manager actions | agent_pending_actions | YES confirmations |
| one-time codes | phone_verifications | sign-in + link unlocks |
| signed links | portal_record_share_links, document_share_links, resident_tour_links | one link service |
| usage billing | manager_comms_usage_events, comms_* | charged to the stamped workspace |
| rollout switch | sms_runtime_config | staged cutover |
| per-resident/vendor numbers | resident_agent_numbers, vendor_work_identities | unused → retire |

## Security, compliance, fair housing (launch blockers)

- Mixed-use campaign registration; compare toll-free vs 10DLC. First reply names
  the business and "Reply STOP to opt out". STOP/HELP/START automatic. No
  unsolicited blasts.
- A phone number alone never unlocks money or private documents.
- Manager commands only from numbers with an active manager role; data changes
  need YES within 10 minutes; every change by text is audit-logged.
- Fair housing: match only on price, dates, location, room features, rules that
  apply to everyone. Never ask about or filter by protected classes (incl.
  Seattle's). No steering descriptions of neighborhoods or roommates.
- Emergency keywords → safety instructions + immediate manager alert.
- Private photo storage, RLS, no PII in URLs.

## Cost

Stay on Twilio behind one `sendMessage()` interface. Push before SMS when the user
has the app. One 160-char GSM-7 segment where possible (no emoji/curly quotes).
Links over MMS. Own the OTP sends.

## Production migration (human-run only)

Additive schema only; nothing dropped until 60 days after cutover. Runbook: stop
new number spend → get the shared number registered → rehearse on staging →
additive schema → idempotent backfill (normalize phones, global contacts, stamp
workspaces, aliases, copy opt-outs) → shadow mode (old numbers keep working;
router decisions logged and compared) → pilot (own workspace) → switch everyone
(one "We've moved" notice; old numbers auto-reply + forward) → retire after 60
days. Rollback: flip runtime mode back to per-number.

Verification queries (before and after): conversation/turn counts match; zero
rows without a workspace stamp; every opted-out phone still opted out; every old
key resolves through an alias; no contact visible to a workspace it had no
thread with before.

**Agents never touch production.** Only a human runs the production steps.

## Testing plan

Every scenario three ways (text, link, app) on staging with Stripe test mode —
prospect (code/no code, tours, apply with OTP lockout + expiry, unknown
question → honest "checking" + alert, steering-prone question, STOP/START),
resident (role flip, rent paid once to ledger, failed payment, leak photo, gas
smell, move-in photos, app sign-in sees history, HUMAN), vendor (offer/accept,
photos → resident confirm, payouts hold, invoice YES, decline → next vendor),
manager (payouts, scoped answers, YES + audit, knowledge approval reused,
co-manager house scoping, digest), cross-team (no reads/searches/alerts across
teams through UI, API or direct DB; one person in two teams; forwarded link
needs code; texted card numbers redacted), money + migration (refund/dispute
ledger, staging verification + rollback, 5,000 messages/day load).
